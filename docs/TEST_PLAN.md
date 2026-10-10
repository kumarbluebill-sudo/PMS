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

## Not covered yet
Mobile layout of authenticated screens, accessibility audit, load/concurrency beyond the cases above, dependency scanning results, cross-browser. Billing/GST/reporting/channel tests belong to later phases.
