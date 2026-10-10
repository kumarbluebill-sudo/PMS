# Implementation Status

Last updated: 2026-10-10. "Done" means verified by an automated test (Vitest 42 tests, Playwright 2 tests) or a recorded manual check.

## Phase 1: Foundation + core PMS

| Module | Status | Verification |
|---|---|---|
| Scaffold, CI workflow, security headers | Done | build, lint, typecheck |
| Permission matrix (14 roles) + custom per-member extra permissions | Done | unit + integration |
| Stay dates (half-open), reservation state machine | Done | unit |
| DB: exclusion constraint vs double booking, append-only audit, RLS | Done | integration (non-superuser role) |
| Auth.js login, session revocation (epoch) | Done | integration + e2e |
| TOTP MFA: enrol, login challenge, forced for privileged roles, admin reset | Done | integration + e2e |
| Password reset (single-use, expiring, revokes sessions), email verification | Done | integration |
| Invitations, member management (role, properties, deactivate, extra permissions), anti-escalation, last-owner protection | Done | integration |
| Tenant registration, onboarding checklist + property settings | Done (checklist, not a multi-step wizard) | e2e |
| Rooms, room types, guests, reservations (auto-assign), cancel, no-show | Done | integration + e2e |
| Check-in (room readiness), check-out (room dirty + task), stay extension, room move | Done | integration (+ e2e for check-in/out) |
| Reservation calendar (14-day grid) | Done | integration (data) |
| Housekeeping, maintenance (blocking + resolve) | Done | integration |
| Audit log screen, full workflow audited | Done | e2e |
| Blueprint docs (`docs/`) | Written; deployment/backup docs are plans, unexercised | n/a |

## Known gaps (Phase 1)
- **Email**: no real provider; messages go to `email_outbox` (contains live tokens: dev only).
- **MFA recovery codes**, login history UI, failed-login persistence/alerts: not built.
- **Rate limiter** is in-memory per instance.
- Calendar page and the UI forms for extend/move/users/onboarding are only covered through services, not browser tests; authenticated mobile layouts are untested.
- Onboarding is a checklist page, not the full 7-step wizard (tax/billing/channel steps belong to later phases).
- Custom roles are per-member extra grants, not named reusable roles.
- Guests: no edit, merge, identity documents, or detail/history page.
- Reservations: no edit of dates/guests (other than extend departure and room move), no groups/multi-room, no rate plans or pricing.
- CSP allows inline scripts; accessibility not audited.
- Playwright not in CI (needs a browser in the runner).
- Nothing deployed; backups/restore not implemented or tested.

## Not started (later phases)
Folios, GST, invoices, payments, accounting, cashier; reports; rates; channel manager; booking engine; SaaS billing; PWA; help center; platform admin.
