# Implementation Status

Last updated: 2026-10-11. "Done" means verified by an automated test (Vitest 218 tests, Playwright 4 tests) or a recorded manual check.

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

## Operations improvements (brief of 2026-10-11): all seven phases done locally, not yet deployed

| Phase | Status | Verification |
|---|---|---|
| A. Room board dashboard: 10 cards from live data, every room listed, derived status (available / reserved / occupied / checkout due / cleaning / maintenance / out of order) with icon + label + legend, filters (date, floor, room type, status, search, arrival/checkout date), sort, table and grid views, quick actions, CSV export (permission-gated), stay detail page with extend / change room | Done | 11 integration tests (`dashboard.test.ts`), 6 unit tests (`roomStatus.test.ts`), e2e board row + mobile overflow |
| B. Out-of-order / maintenance blocks: category, priority, reason, description (required for Other), dates, assignee, approval, resolution with note + readiness confirmation; room returns to "needs cleaning", never straight to sellable; dated blocks only remove the room for the dates covered; check-in refused into a blocked room; append-only room status history | Done | 14 integration tests (`roomblocks.test.ts`), 3 unit tests, e2e block / reason on board / resolve |
| C. Reservation form: check availability + price first (server-calculated nights, rate, discount, GST estimate, per-type availability), then save; new or existing guest, mobile required, 7 booking sources, tentative/confirmed, multi-room group bookings, specific room from the board, discount (permission + reason), optional advance payment on the folio, printable confirmation, atomic locking + DB exclusion constraint | Done | 19 integration tests (`booking.test.ts`), 5 unit tests, e2e flow incl. mobile overflow |
| D. Guest feedback: staff entry (tied to a booking reference), single-use expiring public link (hash only stored, tenant-scoped, no login, no booking reference shown), dashboard (count, average, positive, low, by property / room type / category, date + rating + status + reference filters), internal notes kept separate, complaint status Open / In progress / Resolved, low-rating alerts on the room board and feedback page, guest details and booking refs hidden from roles without guest access | Done | 14 integration tests (`feedback.test.ts`), 5 unit tests, e2e link -> guest submit on a 390px viewport -> link now used -> staff sees it |
| E. Billing: debit notes (own series, tax at the original invoice date), server-generated PDF for every document, extra-person charges, billing summary (room / extra person / restaurant / other / discounts / tax / advance / payments / refunds / outstanding), company folios with audited charge transfers, company-credit payments and manager-approved checkout exceptions, settle-and-check-out page (post nights, pay, exception, final invoice, room left dirty), payment receipts, charge posting with rate x quantity and posting date, GST summary + register with CSV export | Done | 16 integration tests (`billing-ext.test.ts`), 13 unit tests (folio maths, PDF, CSV), e2e PDF download + settlement page |
| F. Settings hub (13 sections): a typed catalogue of 44 settings with permission, range and type checks, audited before/after, encrypted secrets that are never shown; applied by the app: booking reference prefix, min/max stay, booking sources, deposit requested, discount ceiling (bookings + folios), payment methods in use, refund approval limit, maintenance approval and categories, room status labels/colours, invoice terms/footer/logo, receipt footer, confirmation text and policies, report default range, session time limit; sign-in monitoring; honest status pages for channels, subscription, backup and system | Done | 14 integration tests (`settings.test.ts`), 8 unit tests, e2e save-reload-apply + mobile |
| G. Cross-cutting checks: every app screen (32) fits 390px and 768px and has no serious/critical WCAG A/AA violations on desktop; real-data screens (room board, booking quote, invoice, feedback) checked too; dependency audit actioned; unit and integration suites across all phases | Done | `responsive-a11y.spec.ts`, axe checks in `core-flow.spec.ts`, `npm audit` (see docs/SECURITY.md) |

Phase G notes: the automated accessibility check covers WCAG 2.0 A/AA rules that a machine can detect; it does not replace a manual screen-reader and keyboard review. Responsive checks look for sideways scrolling at 390px and 768px, not visual polish. Fixes found by these checks: the main column could not shrink inside the page layout (wide tables forced sideways scrolling at tablet width) and the calendar and front desk used the server's date instead of the property's.

Phase F notes: settings the app does not act on yet are labelled as saved preferences (date format, housekeeping task types, email templates, backup retention, revenue definition). The email provider and API key can be stored but nothing is sent. Channel manager, subscription and backup monitoring are status pages only. Logo is an https link (no upload); it shows on the web invoice but not in the PDF. Adding a property is limited to owner, group admin and general manager. The session limit counts from sign-in (default 12 hours, 15 minutes minimum).

Phase E notes: PDFs use the standard PDF fonts, so the rupee sign prints as "Rs." and non-Latin text prints as "?" (embed a Unicode font before relying on Hindi names). A debit note posts new charges on the folio; their tax uses the rules in force on the original invoice date. Moving charges to a company folio reverses them and re-posts the same amounts with the stored tax breakdown; invoiced charges cannot be moved. Email and WhatsApp delivery of documents are not built (no provider); documents are downloaded or printed. Online payment gateways are not built, so no payment can be marked as gateway-confirmed. Invoice logo / terms text come with the settings phase.

Phase D notes: the guest's original feedback is immutable in the database (only its complaint status can change); notes are append-only; a link can only be marked used, once. Feedback links are shown to staff once and must be sent by the user (no email/WhatsApp provider yet). The public submit is rate-limited per link with the in-memory limiter. "Low" means an overall rating of 1 or 2.

Phase C notes: totals from the browser are ignored; the quote is recomputed on save. Rate plans do not exist yet (the only plan is the room type base rate; a discount stores an agreed nightly rate that the folio then uses). GST in the quote needs an approved rule for registered properties; otherwise the quote says it is unconfigured. If an advance cannot be recorded (e.g. cash with no open shift) the booking is kept and the failure is shown. Check-in in the past is refused for the new form; the legacy `createReservation` helper still allows it. ID numbers are stored encrypted; the PDF is the browser's print-to-PDF; email/WhatsApp delivery needs a provider.

Phase B notes: photo attachments are not built (needs object storage). Blocks raised by a role without `rooms.approve` take effect immediately and are flagged for a different manager to approve. A guest in house prevents a block; overlapping bookings must be acknowledged and are recorded in the audit log, but they are not moved automatically.

Phase A notes: "Available rooms" counts rooms physically free now, including rooms with a later booking (shown separately). Occupied includes checkout-due. "Expected revenue" is tonight's room nights at the room type base rate before tax. "Pending payments" is posted folio balances for in-house guests (unposted room nights are not included). Housekeeping state is shown for today only; other dates are projections. Rooms have an optional floor (`rooms.floor`), editable on the Rooms page. The migration `app_role_policies` is for hosted Postgres that auto-enables RLS (e.g. Supabase) and must be applied there before sign-up works.

## Not started (later phases)
Reports/analytics, rates & restrictions, channel manager, booking engine, SaaS billing/platform admin, backups dashboard, PWA, help center, deployment.

## Upgrade 2026-10-14: structure, planner, wizard, documents, WhatsApp, UX shell
Verified by Vitest (248 tests, 27 files) and Playwright (4 tests incl. every new page at 390/768 px and an axe scan); migrations `20261014100000_structure`, `20261014110000_planner_onboarding`, `20261014120000_whatsapp`.

| Area | Status | Notes |
|---|---|---|
| Buildings and floors (add, reorder, deactivate, never delete) | Done | `/app/structure`; legacy `Room.floor` kept in sync; existing rooms backfilled into "Main Building" |
| Room categories: description, bed configuration, amenities | Done | `/app/room-types` |
| Floor plan: grid placement, one room per cell, keyboard/number inputs (no drag-and-drop) | Done | `/app/rooms/plan`; dashboard "Floor plan" view and building filter |
| Room import from CSV and Excel (.xlsx), template, row-level errors, all-or-nothing | Done | `/app/rooms/import` |
| Setup wizard with saved progress, review and confirm | Done | `/onboarding`; `onboarding_states` |
| Document designer: header, payment instructions, signature line, receipt layout (A4 / 80 mm), preview | Done | Settings > Billing |
| Receipt and advance receipt PDFs | Done | `/app/payments/[id]/pdf`; advance = payment taken before arrival and check-in |
| WhatsApp via Twilio: consent, 8 templates, log, retry, signed delivery webhook, test mode | Done | `/app/messages`; **never reports "sent" without provider acceptance** |
| Skeleton loading, breadcrumbs, reduced motion, focus ring, remembered dashboard view, roles matrix, integration health | Done | cookie `pms_dash_view` (this device only) |

### Limits of this upgrade (honest list)
- **Logo upload / Supabase Storage is not built.** The logo is still an https address (`general.logoUrl`). The system page reports storage as "Not configured".
- **PDFs still print "Rs." and cannot show non-Latin text** (standard PDF fonts; no Unicode font embedded). No folio PDF; the folio has a print page.
- **WhatsApp is manual-send only.** There is no scheduled job for pre-arrival or checkout reminders, and no automatic send on booking events. Real delivery needs a Twilio account, a WhatsApp sender, and Meta-approved templates (paste each template's Content SID). Credentials are server environment variables (one Twilio account for the deployment), not per hotel. Repeat messages for the same booking are blocked except payment and checkout reminders, which are allowed once per day.
- Drag-and-drop floor layout is not built; placement uses column/row inputs.
- Room numbers stay unique per property (not per building).
- Dashboard preferences are stored in a cookie, not per user in the database.
- GST rules remain unreviewed by a qualified professional (`docs/GST_COMPLIANCE.md`).
- Roles matrix is read-only; per-member extra permissions are unchanged.

### New environment variables (all optional)
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (WhatsApp-enabled sender, e.g. `+14155238886`). Without all three the app runs in test mode. Set the Twilio status-callback to nothing: the app sends its own callback URL (`$AUTH_URL/api/webhooks/twilio?t=<tenant>`) with each message, so `AUTH_URL` must be the public https address.

## Front Office Command Centre (2026-10-15)
Verified by Vitest (267 tests, 30 files, including `tests/integration/frontoffice.test.ts`) and Playwright (8 tests: command-centre views, full arrival to check-in flow, drawer and settings drawer, axe contrast and 390/768 px overflow on every new page). Migration `20261015100000_front_office`.

| Area | Status | Notes |
|---|---|---|
| Header with hotel and business date, global search, alerts bell, profile; quick-action bar | Done | Search covers rooms, reservations and guests, each only if the viewer has the permission |
| Narrow icon rail on the dashboard, expandable; settings gear drawer with permitted links only | Done | |
| Command-centre layout: room grid about 72%, performance and alerts about 28%, independent scrolling; phone slide-over | Done | |
| 18 performance tiles, each linking to a filtered list or worklist; occupancy vs yesterday | Done | Room revenue, ARR and RevPAR hidden without billing access |
| Room tiles, table and floor-plan views; filters; status chips with live counts | Done | |
| Today's Operations: 15 worklists, each row links to its reservation | Done | `/app/operations` |
| Check-in workflow (registration, encrypted ID, verify ID, assign or change room, requests and VIP, advance link, registration confirmation print) | Done | `/app/check-in/[id]`; ID number never shown or audited |
| Checkout control (charges, discounts, payments, balance, invoices, links to folio and settlement) | Done | Completion still goes through the existing settlement flow, which blocks silent write-offs |
| Analytics: occupancy, ARR, RevPAR, revenue by night (posted vs estimated), by floor and category, sources, 7/14/30 days | Done | `/app/dashboard/analytics`; hand-drawn accessible SVG charts |
| Alerts (derived live, severity, acknowledge, resolve with note, audited) and manager block | Done | `/app/alerts`; manager view = users with `audit.view` and `rooms.approve` |
| No-show review: candidates after the configured time, staff confirmation with a note, never automatic | Done | Setting `frontoffice.noShowCutoffTime` |

### Limits (honest list)
- **Room nights are posted to folios only at checkout** (no night audit). Revenue for in-house nights is therefore an estimate from the booked rate, labelled as such. Posted and estimated amounts are shown separately.
- Historical "out of order" nights are only known where a maintenance block recorded them; the live out-of-order flag applies to today onward.
- A stay that moved rooms is attributed to its last room in the by-floor and by-category splits.
- Early check-in and late checkout are recorded and shown; no fee is charged automatically. There is no separate Front Office Manager role; the manager view follows permissions.
- ID photo upload and signature capture are not built. Notifications refresh on a timer (`frontoffice.dashboardRefreshSeconds`, default off) or on demand, not by push.
- New settings (Settings > Reservations): `frontoffice.noShowCutoffTime`, `frontoffice.requireIdAtCheckin`, `frontoffice.dashboardRefreshSeconds`.

## Professional Front Desk Upgrade (2026-10-16)
Verified by Vitest (282 tests, 34 files) and Playwright (8 tests, including the reservation list, calendar bar and the new settings page in the axe and 390/768 px scans). Migration `20261016100000_reservation_ref` (additive: `reservations.externalRef`, `reservation_status_history.reason`).

| Area | Status | Notes |
|---|---|---|
| Reservation list | Done | Phone/email, nights, guests, room type and room, source, status, total, paid, balance, creator and date; search, sort, 25 per page; filters for arrival and departure range, status, category, source, room, payment status. Money is hidden without `billing.view` |
| New reservation page | Done | Moved to `/app/reservations/new` (dates, price, guest and booking); OTA or channel reference field added |
| Change history | Done | Detail page timeline: status moves, room, dates, requests, payments, refunds, discounts, with who and why. Cancel now asks for a reason |
| Room calendar | Done | Bars across nights, sticky date row and room column, today highlight, 1/2-week and 30-day ranges, jump to date, building, floor, category, vacancy and guest or room search, blocks shown hatched, overlap with a block flagged, same-day turnover marked, empty cell opens a booking for that room |
| Folio ledger | Done | Qty, rate, discount, taxable value, GST split (CGST/SGST/IGST/cess), payment method and reference, receipt link; folio statement PDF |
| Invoice themes | Done | Classic, Luxury, Modern, Resort, Compact; accent colour and typeface; live sample under Settings > Invoice design; saved in the billing settings. Themes change colour and type only (a test checks the totals and GSTIN are drawn identically in every theme) |
| GST | Done | Excel workbook export next to the CSVs (SAC-wise summary and invoice register) |
| Audit log | Done | Filters (action, record type, dates, record id), who acted, before and after, paging |
| Checkout | Done | A balance exception (company credit or approved unpaid) now needs `billing.waive` before any charge is posted or invoice issued |

### Limits (honest list)
- The booking form keeps its three on-page steps rather than a separate four-step wizard. Extra-person pricing (`RoomType.extraAdultRateMinor`) is still not used in the quote, and there is no approval queue for large discounts: a cap and the `billing.discount` permission remain the control.
- No drag-and-drop on the calendar. Moving a room or extending a stay is done from the reservation page with a reason. No waitlist.
- Calendar bars are whole nights (no half-day arrival and departure slots). Cancelled stays do not show.
- Advance receipts already existed as payment receipts taken before arrival. There is no separate cancellation document; a credit note covers invoiced corrections.
- Logo upload (needs file storage), a Unicode PDF font (the rupee sign prints as "Rs."), receipt printer themes beyond the 80 mm layout, and night audit are still open.
- GST treatment and rates must be reviewed by a qualified tax professional.
