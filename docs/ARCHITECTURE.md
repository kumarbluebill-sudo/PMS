# Architecture

Multi-tenant hotel PMS on Next.js 16 (App Router, server actions), Prisma 7 and PostgreSQL.

## Layers
| Layer | Location | Rule |
|---|---|---|
| UI (server components + forms) | `src/app/**` | No business logic; calls services through server actions. |
| Server actions | `src/app/actions.ts`, `account-actions.ts` | Resolve context via `getCtx()`, call a service, redirect with a safe message. |
| Services | `src/server/services/*` | Every function takes `(db, ctx, input)`, calls `authorize(ctx, permission)`, validates input with Zod, and runs data access in `withTenant`. |
| Domain | `src/server/domain/stay.ts` | Pure functions: half-open stay dates, reservation state machine. |
| Auth | `src/auth.ts`, `src/server/auth/*`, `session.ts` | Auth.js credentials + TOTP; permission matrix; context loader. |
| Data | `prisma/`, `src/server/db/*` | Prisma schema, SQL constraints, tenant-scoped transactions. |

## Tenant isolation (defence in depth)
1. **Context**: `loadContext` derives tenant, role and accessible properties from the database (active user, matching `sessionEpoch`, active membership). The browser sends only a user id + epoch (JWT) and an optional property cookie, which is honoured only if it is in the user's accessible list.
2. **Row-level security**: property-scoped tables have `FORCE ROW LEVEL SECURITY` with a policy on `current_setting('app.tenant_id')`. `withTenant()` sets it with `set_config(..., true)` inside the transaction. The application must connect as a role without `BYPASSRLS` (`APP_DATABASE_URL`).
3. **Service filters**: queries also filter by `propertyId`; `audit_logs`, `users`, `tenant_memberships` and `auth_tokens` have no RLS and rely on explicit `tenantId` filters in services.

## Double-booking prevention
`room_assignments` has an exclusion constraint (`btree_gist`) on `(roomId, daterange(arrival, departure, '[)'))` for active rows. Services pre-filter free rooms for UX, but the constraint is the arbiter; on a conflict the next candidate room is tried.

## Sessions and revocation
JWT sessions (12h). `users.sessionEpoch` is bumped on password reset, deactivation, role change and MFA reset, which invalidates all issued tokens at the next request.

## Not yet built
Billing/GST, reports, channel manager, booking engine, SaaS billing, background jobs. See `IMPLEMENTATION_STATUS.md`.
