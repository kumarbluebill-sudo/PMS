# Implementation Status

Last updated: 2026-10-10. "Done" means verified by an automated test (Vitest 92 tests, Playwright 2 tests) or a recorded manual check.

## Phase 1: Foundation + core PMS - done (see git history); known gaps
Email has no real provider (`email_outbox`, dev only, holds live tokens); no MFA recovery codes; in-memory rate limiter; onboarding is a checklist; extra permissions are per-member, not named roles; no guest editing or multi-room bookings; Playwright not in CI.

## Phase 2: Billing, GST, accounting

| Module | Status | Verification |
|---|---|---|
| GST engine (effective-dated rules, tariff bands, CGST/SGST/IGST/cess, inclusive/exclusive, exempt/nil/unregistered, integer money) | Done | 21 unit tests incl. rounding stress |
| GSTIN checksum + state code validation | Done | unit (published sample GSTIN) |
| Tax rules: draft -> maker-checker approval -> retire; immutable once approved | Done | integration + DB trigger |
| GST registration settings (reason-required, audited) | Done | integration |
| Folios + append-only ledger; charges, tax-inclusive, discounts (permission, reason, cap), room-night posting | Done | integration |
| Payments (cash/UPI/card/bank/other) with idempotency; staff-confirmed only | Done | integration (concurrent duplicates) |
| Refunds (permission, reason, capped by paid, per-method) | Done | integration |
| Cash shifts: open/close, expected vs counted, variance reason, separate approver | Done | integration |
| Check-out gated on folio balance; manager waiver with reason | Done | integration + e2e |
| Invoices / Bills of Supply: preview from ledger, issue with gapless per-FY numbering, immutable | Done | integration (concurrency) + e2e |
| Credit notes (reverse ledger lines, own series, once per line) | Done | integration |
| Double-entry journal (auto-posted), trial balance, reconciliation checks | Done | integration |
| UI: folios, folio detail, invoices (printable), credit notes, payments, cashier, accounting, GST & tax settings | Done (functional) | build + e2e for the folio/payment/invoice/checkout path |

## Known gaps (Phase 2) - honest list
- **No GST rates are shipped and the engine is unreviewed by a GST professional.** See `docs/GST_COMPLIANCE.md`.
- **No PDF generation**: invoices are printable web pages. No email/WhatsApp delivery.
- **Not built**: debit notes, advance/deposit receipts and GST on advances, folio transfers/split folios, company/travel-agent master billing, reverse charge, e-invoicing, GSTR exports, SAC/HSN summary, online payment gateway and webhook confirmation, cash expenses in shifts, P&L / balance sheet / payables / expenses / period close, accounting exports.
- Browser tests do not cover the GST-registered path (maker-checker needs two users), credit-note UI, cashier UI, or billing screens on mobile.
- Room charges use the room type's base rate (no rate plans, seasonal rates, extra-person charges) and are posted manually or at check-out, not by a nightly audit job.
- A single amount is capped at Rs 1,00,00,000 (32-bit paise columns).
- Guest GSTIN/company fields exist in the schema but there is no guest-edit UI; B2B recipients are entered on the invoice form.

## Not started (later phases)
Reports/analytics, rates & restrictions, channel manager, booking engine, SaaS billing/platform admin, backups dashboard, PWA, help center, deployment.
