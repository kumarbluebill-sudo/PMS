# Deployment (draft, not yet exercised)

Targets: GitHub + Vercel + managed PostgreSQL (e.g. Supabase). **Nothing has been deployed yet.**

## Environment variables
`DATABASE_URL` (admin, migrations only), `APP_DATABASE_URL` (restricted `pms_app` role, runtime), `AUTH_SECRET`, `AUTH_URL`, `APP_ENCRYPTION_KEY` (32 bytes base64). Never commit `.env`.

## Steps
1. Create the database. Run reviewed migrations manually: `DATABASE_URL=<admin> npx prisma migrate deploy` (never on app start).
2. Create the runtime role and grants (see `tests/integration/global-setup.ts`): `NOSUPERUSER NOBYPASSRLS`, `GRANT SELECT,INSERT,UPDATE,DELETE` on tables, default privileges for future tables.
3. Set env vars in Vercel for Preview and Production separately.
4. Replace the in-memory rate limiter with a shared store; wire a real email provider (outbox is dev-only).
5. Vercel project: framework Next.js, build `npm run build`.

## Pre-release checklist
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run test:e2e` green
- [ ] App connects as `pms_app` (verify `SELECT rolbypassrls` is false)
- [ ] MFA enforced for an owner account on staging
- [ ] Backups configured and one restore tested (see `BACKUP_AND_RECOVERY.md`)
- [ ] Email provider live; reset/invite emails received

## Hosted Postgres that turns on row-level security automatically (e.g. Supabase)

Such hosts enable RLS on every new table. Tables with a tenant policy are fine; the shared tables (tenants, users, memberships, tokens, audit, outbox) have none and the runtime role `pms_app` would be denied everything, so sign-up fails with "Something went wrong". Migration `20261011120000_app_role_policies` adds a policy for `pms_app` only (other roles, including the provider's public API roles, still see nothing) and a read-only policy on Prisma's bookkeeping table. Every later migration that adds a table also grants it to `pms_app` when that role exists.

Order for a new hosted database: run `prisma migrate deploy` with the admin connection string, create the `pms_app` login role (NOSUPERUSER, NOBYPASSRLS), then run `prisma migrate deploy` again (the migrations are idempotent) so the policy and grants apply, and point `APP_DATABASE_URL` at `pms_app`.
