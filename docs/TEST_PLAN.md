# Test plan

Run: `npm run db:start` (local Postgres, keep running) then
- `npm test` - Vitest: unit + integration against the real database (`pms_test`, non-superuser role so RLS applies).
- `npm run build && npm run test:e2e` - Playwright in Edge (`PW_CHANNEL=chrome` to change).

## Covered today
| Area | Level | Examples |
|---|---|---|
| Permissions, stay dates, state machine | Unit | housekeeping cannot see finance; departure day not a night; CHECKED_OUT is terminal |
| Double booking | Integration | 8 concurrent raw inserts -> 1 wins; 6 concurrent service bookings on 2 rooms -> 2 succeed |
| Audit immutability | Integration | update/delete rejected |
| Tenant isolation | Integration | RLS hides rows, blocks cross-tenant writes, no context -> no rows; services cannot touch another tenant's reservation; forged property id ignored |
| Auth | Integration + E2E | credentials, session revocation, reset (single-use, expiry), MFA enrol/login, forced MFA, admin MFA reset |
| Members | Integration | invite/accept once, no privilege escalation, deactivation revokes session, last-owner/self protection, extra permissions |
| Stays | Integration | extend (clash rejected), room move, calendar, maintenance blocks sale, dirty-room check-in refused |
| Full workflow | E2E | register, MFA, rooms, guest, booking, overbook refused, check-in/out, dirty room, audit entries, MFA re-login; mobile overflow check on /login |
| GST engine | Unit | CGST=SGST always, components sum to tax, inclusive keeps gross, negatives mirror positives, effective dates, tariff bands, overlap/none errors, GSTIN checksum, financial year |
| Billing | Integration | maker-checker, immutable rules, ledger and invoice immutability, discounts, idempotent payments (5 concurrent -> 1), shift reconciliation + separate approver, refund limits, concurrent invoice issue (no gaps/duplicates), credit notes, tenant isolation, unregistered bill of supply |
| Accounting | Integration | journal balances, receivable = folio balances, revenue/tax accounts tie to the ledger, DB rejects an unbalanced entry |
| Money parsing | Unit | no float error, junk rejected |
| Room board | Unit + Integration + E2E | status precedence, timezone dates; every room listed, status/guest/checkout match the active stay, cards reconcile with rooms, out-of-order/maintenance rooms cannot be sold, filters/sort, future-date projection, role redaction, tenant isolation; board visible with text status, no overflow at 390px |
| Room blocks | Unit + Integration + E2E | report vs block vs out of order, dated windows (inclusive end, arrival on last blocked day), form validation, in-house guest and overlapping-booking handling, check-in refused, approval needs another manager, resolution needs note + readiness, restored room needs cleaning, history append-only + RLS, role checks |
| Booking | Unit + Integration + E2E | quote maths (rate, discount, GST on/off/unconfigured), date validation, mobile validation, multi-room groups, occupancy, concurrency (6 for 1 suite -> 1; 5 for 3 rooms -> 3), specific room, tampered totals ignored, sources, discount permission + reason + agreed rate drives charges, advance recorded / failure keeps the booking, tentative hold/confirm/cancel, confirmation access; availability then save flow at 1280 and 390px |
| Feedback | Unit + Integration + E2E | staff entry tied to booking, validation (1-5, duplicates, unknown ref), complaint auto-open, link only during/after stay, hash-only storage, minimal public data, single-use incl. concurrent, expired/malformed/tampered/cross-tenant links, exact averages and breakdowns with filters, PII redaction, notes/status audited, DB immutability, alerts; link -> guest submit (mobile) -> staff view |
| Billing extensions | Unit + Integration + E2E | extra-person maths and posting, billing summary adds up, advance vs payments, posting-date and quantity rules, company folios and transfers (history kept, tax carried, no double invoicing, reconcile still balanced), company-credit permission and accounting, settle-and-check-out (no change on failure, payment guard, invoice, room dirty, manager exceptions, audit), debit notes (series, balance, original untouched, immutable), GST summary equals register, CSV injection guard, receipts, PDF validity and pagination; PDF download and settlement page in the browser |
| Settings | Unit + Integration + E2E | catalogue defaults valid, permissions real, unsafe/out-of-range values rejected, all-or-nothing saves, audit before/after and no-op saves not logged, per-permission edit rights (backup, security, billing), secrets encrypted and never returned, tenant and property scoping, every enforcement point (prefix, stay length, sources, discounts, methods, refund limit, approval, categories, deposit), status labels, sign-in monitoring, session expiry rule; save, reload and see it applied, at 390px |
| Billing UI | E2E | checkout refused with balance, post charges, UPI payment, bill of supply, checkout |

## Not covered yet
GST-registered flow in the browser (maker-checker needs two users), credit-note UI, cashier UI, mobile layouts of billing screens, PDF output, mobile layout of other authenticated screens, accessibility audit, load/concurrency beyond the cases above, dependency scanning results, cross-browser. Billing/GST/reporting/channel tests belong to later phases.
