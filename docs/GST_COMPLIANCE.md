# GST compliance

**This software is not GST-certified and has not been reviewed by a GST professional.** No GST rates, SAC codes or slabs are built in. A qualified Indian GST professional must verify the configuration (registration details, rules, tariff bands, effective dates) and the invoice format before any real invoice is issued.

## What is implemented (Phase 2)
| Requirement | Implementation | Verified by |
|---|---|---|
| No hardcoded rates | Rates live in `tax_rules` (basis points), entered per tenant | `gst.test.ts` uses arbitrary fixture rates |
| Effective-dated rules | `effectiveFrom` (inclusive) / `effectiveTo` (exclusive); rule chosen from the **service date**, not the booking date | unit tests |
| Tariff bands | `tariffMinMinor` inclusive / `tariffMaxMinor` exclusive, matched on the per-unit pre-tax amount (e.g. room rate per night). Discounts reuse the discounted charge's tariff so the same band applies | unit + integration |
| Exactly one rule must apply | none -> refuse to charge; overlapping -> error; overlapping approved rules are also blocked at approval | unit + integration |
| Maker-checker | creator cannot approve; approver needs `tax.approve`; approved rules are immutable (DB trigger), only retirable with a reason; new version = new draft | integration |
| CGST/SGST vs IGST | place of supply = property state (`PROPERTY_STATE`) or recipient state (`RECIPIENT_STATE`) per rule. Equal CGST/SGST; IGST when place of supply differs from the supplier state | unit |
| Tax-inclusive / exclusive | gross is fixed for inclusive; net = gross - tax | unit (property-style rounding stress test) |
| Exempt / nil-rated / unregistered | recorded with the rule used; unregistered suppliers charge no tax and issue a **Bill of Supply** | unit + integration + e2e |
| Cess | optional per rule | unit |
| Integer money | paise as integers; `divRound` half-up; no floats; amounts capped at Rs 1,00,00,000 per entry | unit |
| Reproducible history | each ledger entry stores the full tax breakdown (rule id + version, legal reference, SAC, rates, components, supply type) | integration |
| GSTIN validation | structure, state code, mod-36 check digit (verified against a published sample GSTIN) | unit |
| Invoice numbering | per property, series and Indian financial year (April-March); atomic `INSERT ... ON CONFLICT DO UPDATE` counter inside the issuing transaction; numbers <= 16 chars; gapless because a rollback rolls the counter back. Series: `PFX` tax invoice, `PFXB` bill of supply, `PFXC` credit note | integration (concurrent issue: no gaps, no double invoicing) |
| Immutable invoices | DB triggers reject UPDATE/DELETE on invoices and lines; one folio entry can appear on at most one document (unique index) | integration |
| Corrections | credit notes reverse ledger lines (new `REVERSAL` entries) and are numbered in their own series; each line can be credited once | integration |
| Supplier/recipient snapshot | stored on the invoice; supplier GSTIN, legal name, address required when registered; recipient GSTIN validated | integration |
| Audit | rule create/approve/retire, GST settings changes (with before/after and a mandatory reason), invoices, credit notes | integration |

## Rounding policy
Per line, per component, half-up to the paisa. Inclusive prices keep gross fixed. No invoice-level round-off. Confirm this matches your accountant's practice.

## Not implemented / needs professional input
- **PDF generation**: invoices render as a printable web page ("Print / save as PDF"); there is no server-generated PDF yet.
- **Debit notes**, advance receipts (receipt vouchers) and GST on advances, reverse charge, e-invoicing (IRN/QR), e-way bills, GSTR-1/3B exports, HSN/SAC summary report, composition scheme, TCS/TDS, and the time limits for issuing credit notes are not implemented.
- **Rate decisions** (e.g. which room-tariff band or restaurant treatment applies, whether input tax credit is allowed) are entirely the user's configuration; the software does not advise.
- Place-of-supply logic is limited to the two options above.
- Invoice dates use the property's timezone date; the financial year is derived from it.
- Hotel-specific invoice particulars required by law must be checked against the printed layout by a professional.
