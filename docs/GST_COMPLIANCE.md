# GST compliance (design notes for Phase 2; nothing implemented)

This application is **not** GST-certified and no GST calculation exists yet. Do not issue real invoices from it.

## Design commitments
- Dedicated server-side tax engine; rules are data (service category, SAC, components CGST/SGST/IGST/cess, rate, effective from/to, legal reference, version, approval status, approver), never hardcoded.
- Money in integer minor units; documented rounding policy; per-line and per-invoice tax breakdown stored with the invoice so history is reproducible.
- Rule selection from transaction facts (service type, place of supply, supplier/recipient registration, tariff/room-rate facts, effective date), not booking date alone.
- Issued invoices are immutable; corrections via credit/debit notes; gapless-by-series numbering with collision protection; issuance in one DB transaction with ledger entries.
- Configuration must be reviewed by a qualified GST professional before go-live; keep a verification checklist.
