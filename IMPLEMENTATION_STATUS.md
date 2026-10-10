# Implementation Status

Last updated: 2026-10-10. Status is only "Done" when the behaviour is verified by a passing test or manual check.

| Module | Status | Notes |
|---|---|---|
| Project scaffold (Next.js 16, TS strict, Tailwind 4) | Done | |
| Permission matrix (14 roles) | Done (unit-tested) | `src/server/auth/permissions.ts` |
| Stay-date / state-machine domain logic | Done (unit-tested) | `src/server/domain/stay.ts` |
| Prisma schema (core PMS subset) + migrations | Done | init + constraints migrations applied |
| DB exclusion constraint vs double booking | Done (integration-tested, incl. 8 concurrent bookings -> 1 wins) | |
| Audit log append-only trigger | Done (integration-tested) | |
| Auth.js + MFA | Not started | |
| Tenant isolation (RLS + tests) | DB layer done (tested with non-superuser role); app-layer context pending | `withTenant` in src/server/db |
| Rooms / guests / reservations UI | Not started | |
| Front desk, housekeeping | Not started | |
| Folios, GST, invoices, payments, accounting, cashier | Not started (Phase 2) | |
| Reports, channel manager, booking engine, SaaS billing, backups, PWA, help center | Not started (later phases) | |

Environment notes: Docker is not installed on the dev machine; local Postgres runs via `embedded-postgres` (dev dependency). `docker-compose.yml` is provided for machines with Docker. Prisma is pinned to 7.10.0 (stable); `latest` currently points to an RC.
