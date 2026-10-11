# Implementation Status

Last updated: 2026-10-10. "Done" means verified by an automated test (Vitest 151 tests, Playwright 2 tests) or a recorded manual check.

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

## Operations improvements (in progress, brief of 2026-10-11)

| Phase | Status | Verification |
|---|---|---|
| A. Room board dashboard: 10 cards from live data, every room listed, derived status (available / reserved / occupied / checkout due / cleaning / maintenance / out of order) with icon + label + legend, filters (date, floor, room type, status, search, arrival/checkout date), sort, table and grid views, quick actions, CSV export (permission-gated), stay detail page with extend / change room | Done | 11 integration tests (`dashboard.test.ts`), 6 unit tests (`roomStatus.test.ts`), e2e board row + mobile overflow |
| B. Out-of-order / maintenance blocks: category, priority, reason, description (required for Other), dates, assignee, approval, resolution with note + readiness confirmation; room returns to "needs cleaning", never straight to sellable; dated blocks only remove the room for the dates covered; check-in refused into a blocked room; append-only room status history | Done | 14 integration tests (`roomblocks.test.ts`), 3 unit tests, e2e block / reason on board / resolve |
| C. Reservation form: check availability + price first (server-calculated nights, rate, discount, GST estimate, per-type availability), then save; new or existing guest, mobile required, 7 booking sources, tentative/confirmed, multi-room group bookings, specific room from the board, discount (permission + reason), optional advance payment on the folio, printable confirmation, atomic locking + DB exclusion constraint | Done | 19 integration tests (`booking.test.ts`), 5 unit tests, e2e flow incl. mobile overflow |
| D. Guest feedback | Not started | |
| E. Billing gaps (debit notes, PDF, categories, checkout exceptions) | Not started | |
| F. Central settings hub | Not started | |
| G. Cross-cutting tests / responsive checks | Not started | |

Phase C notes: totals from the browser are ignored; the quote is recomputed on save. Rate plans do not exist yet (the only plan is the room type base rate; a discount stores an agreed nightly rate that the folio then uses). GST in the quote needs an approved rule for registered properties; otherwise the quote says it is unconfigured. If an advance cannot be recorded (e.g. cash with no open shift) the booking is kept and the failure is shown. Check-in in the past is refused for the new form; the legacy `createReservation` helper still allows it. ID numbers are stored encrypted; the PDF is the browser's print-to-PDF; email/WhatsApp delivery needs a provider.

Phase B notes: photo attachments are not built (needs object storage). Blocks raised by a role without `rooms.approve` take effect immediately and are flagged for a different manager to approve. A guest in house prevents a block; overlapping bookings must be acknowledged and are recorded in the audit log, but they are not moved automatically.

Phase A notes: "Available rooms" counts rooms physically free now, including rooms with a later booking (shown separately). Occupied includes checkout-due. "Expected revenue" is tonight's room nights at the room type base rate before tax. "Pending payments" is posted folio balances for in-house guests (unposted room nights are not included). Housekeeping state is shown for today only; other dates are projections. Rooms have an optional floor (`rooms.floor`), editable on the Rooms page. The migration `app_role_policies` is for hosted Postgres that auto-enables RLS (e.g. Supabase) and must be applied there before sign-up works.

## Not started (later phases)
Reports/analytics, rates & restrictions, channel manager, booking engine, SaaS billing/platform admin, backups dashboard, PWA, help center, deployment.
