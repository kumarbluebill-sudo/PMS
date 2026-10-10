# Project plan

Source requirement: the MK Solutions master prompt (cloud hotel PMS, channel manager, GST billing, revenue management).

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation + core PMS: tenancy, auth/MFA, RBAC, audit, rooms, guests, reservations, front desk, housekeeping, maintenance, calendar, users | Built; see `IMPLEMENTATION_STATUS.md` |
| 2 | Folios, charges, GST engine (effective-dated rules, integer money), invoices, payments, refunds, credit notes, cashier, ledger | Not started |
| 3 | Reporting: occupancy, ADR, RevPAR, revenue, GST, audit reports, exports | Not started |
| 4 | Rates and restrictions; channel manager (provider interface, mock adapter, sync queue); direct booking engine | Not started |
| 5 | Platform admin and SaaS subscriptions with server-side limits | Not started |
| 6 | Backups/DR verification, monitoring, PWA, help center with real screenshots, deployment | Not started |

## Risks
- GST rules must be validated by a qualified Indian GST professional before any real invoice.
- Live OTA connections need partner approval and credentials; only a mock/sandbox adapter can be built without them.
- Real email, payment gateway and backup/restore need external accounts.
