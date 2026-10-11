# Implementation Status

Last updated: 2026-10-10. "Done" means verified by an automated test (Vitest 216 tests, Playwright 2 tests) or a recorded manual check.

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
- **PDF** is generated on the server (see Phase E notes). No email/WhatsApp delivery.
- **Not built**: advance/deposit receipts and GST on advances (an advance is recorded as a folio payment and printed as a payment receipt, not a GST receipt voucher), master billing across several reservations, reverse charge, e-invoicing, GSTR returns (the GST summary and register export are accountant aids), online payment gateway and webhook confirmation, cash expenses in shifts, P&L / balance sheet / payables / expenses / period close, accounting exports.
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
| D. Guest feedback: staff entry (tied to a booking reference), single-use expiring public link (hash only stored, tenant-scoped, no login, no booking reference shown), dashboard (count, average, positive, low, by property / room type / category, date + rating + status + reference filters), internal notes kept separate, complaint status Open / In progress / Resolved, low-rating alerts on the room board and feedback page, guest details and booking refs hidden from roles without guest access | Done | 14 integration tests (`feedback.test.ts`), 5 unit tests, e2e link -> guest submit on a 390px viewport -> link now used -> staff sees it |
| E. Billing: debit notes (own series, tax at the original invoice date), server-generated PDF for every document, extra-person charges, billing summary (room / extra person / restaurant / other / discounts / tax / advance / payments / refunds / outstanding), company folios with audited charge transfers, company-credit payments and manager-approved checkout exceptions, settle-and-check-out page (post nights, pay, exception, final invoice, room left dirty), payment receipts, charge posting with rate x quantity and posting date, GST summary + register with CSV export | Done | 16 integration tests (`billing-ext.test.ts`), 13 unit tests (folio maths, PDF, CSV), e2e PDF download + settlement page |
| F. Settings hub (13 sections): a typed catalogue of 44 settings with permission, range and type checks, audited before/after, encrypted secrets that are never shown; applied by the app: booking reference prefix, min/max stay, booking sources, deposit requested, discount ceiling (bookings + folios), payment methods in use, refund approval limit, maintenance approval and categories, room status labels/colours, invoice terms/footer/logo, receipt footer, confirmation text and policies, report default range, session time limit; sign-in monitoring; honest status pages for channels, subscription, backup and system | Done | 14 integration tests (`settings.test.ts`), 8 unit tests, e2e save-reload-apply + mobile |
| G. Cross-cutting tests / responsive checks | Not started | |

Phase F notes: settings the app does not act on yet are labelled as saved preferences (date format, housekeeping task types, email templates, backup retention, revenue definition). The email provider and API key can be stored but nothing is sent. Channel manager, subscription and backup monitoring are status pages only. Logo is an https link (no upload); it shows on the web invoice but not in the PDF. Adding a property is limited to owner, group admin and general manager. The session limit counts from sign-in (default 12 hours, 15 minutes minimum).

Phase E notes: PDFs use the standard PDF fonts, so the rupee sign prints as "Rs." and non-Latin text prints as "?" (embed a Unicode font before relying on Hindi names). A debit note posts new charges on the folio; their tax uses the rules in force on the original invoice date. Moving charges to a company folio reverses them and re-posts the same amounts with the stored tax breakdown; invoiced charges cannot be moved. Email and WhatsApp delivery of documents are not built (no provider); documents are downloaded or printed. Online payment gateways are not built, so no payment can be marked as gateway-confirmed. Invoice logo / terms text come with the settings phase.

Phase D notes: the guest's original feedback is immutable in the database (only its complaint status can change); notes are append-only; a link can only be marked used, once. Feedback links are shown to staff once and must be sent by the user (no email/WhatsApp provider yet). The public submit is rate-limited per link with the in-memory limiter. "Low" means an overall rating of 1 or 2.

Phase C notes: totals from the browser are ignored; the quote is recomputed on save. Rate plans do not exist yet (the only plan is the room type base rate; a discount stores an agreed nightly rate that the folio then uses). GST in the quote needs an approved rule for registered properties; otherwise the quote says it is unconfigured. If an advance cannot be recorded (e.g. cash with no open shift) the booking is kept and the failure is shown. Check-in in the past is refused for the new form; the legacy `createReservation` helper still allows it. ID numbers are stored encrypted; the PDF is the browser's print-to-PDF; email/WhatsApp delivery needs a provider.

Phase B notes: photo attachments are not built (needs object storage). Blocks raised by a role without `rooms.approve` take effect immediately and are flagged for a different manager to approve. A guest in house prevents a block; overlapping bookings must be acknowledged and are recorded in the audit log, but they are not moved automatically.

Phase A notes: "Available rooms" counts rooms physically free now, including rooms with a later booking (shown separately). Occupied includes checkout-due. "Expected revenue" is tonight's room nights at the room type base rate before tax. "Pending payments" is posted folio balances for in-house guests (unposted room nights are not included). Housekeeping state is shown for today only; other dates are projections. Rooms have an optional floor (`rooms.floor`), editable on the Rooms page. The migration `app_role_policies` is for hosted Postgres that auto-enables RLS (e.g. Supabase) and must be applied there before sign-up works.

## Not started (later phases)
Reports/analytics, rates & restrictions, channel manager, booking engine, SaaS billing/platform admin, backups dashboard, PWA, help center, deployment.
