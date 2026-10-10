# Implementation Status

Last updated: 2026-10-10. "Done" means verified by a passing automated test or an HTTP smoke test.

## Phase 1: Foundation + core PMS

| Module | Status | Verification |
|---|---|---|
| Scaffold (Next.js 16, strict TS, Tailwind 4), CI workflow, security headers/CSP | Done | build + lint + typecheck pass |
| Permission matrix (14 roles) | Done | unit tests |
| Stay dates (half-open) + reservation state machine | Done | unit tests |
| Prisma schema + migrations (init, constraints) | Done | applied |
| DB exclusion constraint against double booking | Done | integration: 8 concurrent -> 1 wins; service level: 6 requests/2 rooms -> 2 succeed |
| Append-only audit log (DB trigger) | Done | integration |
| Tenant isolation (Postgres RLS + `withTenant`) | Done | integration with non-superuser role; cross-tenant service tests |
| Auth.js credentials login, JWT carries only user id + session epoch | Done | HTTP smoke test (login, redirect when unauthenticated, bad password) |
| Server-derived context (tenant/role/property from DB, forged property id ignored, revoked epoch rejected) | Done | integration |
| Login brute-force limiter | Done, in-memory per instance | needs shared store (Redis) before multi-instance deploy |
| Tenant registration (tenant + owner + first property) | Done | integration + smoke |
| Room types, rooms, guests (contact data hidden from Auditor) | Done | integration |
| Reservations: create/auto-assign room, cancel, no-show, check-in (room readiness), check-out (room -> dirty + task) | Done | integration |
| Housekeeping statuses (inspection needs supervisor permission), maintenance requests blocking sale | Done | integration (permissions); blocking logic not yet directly tested |
| UI: login, register, dashboard, front desk, reservations, guests, rooms, room types, housekeeping, maintenance, audit log | Done (functional, basic styling) | HTTP smoke test: all pages 200 for owner |

## Known gaps in Phase 1 (honest list)
- **MFA, password reset, email verification**: not implemented (`mfaSecretEnc` columns exist, unused). Required before pilot.
- **Onboarding wizard, reservation calendar view, stay extension, room move, user/role management UI, custom roles**: not built. Team members cannot be invited yet (only the owner exists after registration).
- **Playwright e2e**: not set up; verification so far is Vitest integration tests plus a curl-based smoke test.
- **Check-out has no folio/balance check** (billing phase).
- Housekeeping and maintenance pages have no history/assignment features; maintenance requests cannot be resolved from the UI yet.
- RLS covers property-scoped tables; `audit_logs`, `users`, `tenant_memberships` rely on application-layer filtering.
- Production should connect as a non-BYPASSRLS role (`APP_DATABASE_URL`), with a separate admin URL for migrations.
- Most Phase 1 blueprint docs (ARCHITECTURE, SECURITY, etc.) are not written yet.

## Not started (later phases)
Folios, GST engine, invoices, payments, accounting, cashier; reports/analytics; channel manager; booking engine; SaaS billing; backups dashboard; PWA; help center; Vercel deployment config.

## Environment notes
Docker is not installed on the dev machine; local Postgres runs via `embedded-postgres` (`npm run db:start`). Create the `pms_app` role as in `tests/integration/global-setup.ts`. Prisma pinned to 7.10.0 (`latest` is an RC).
