# Security

## Implemented
- Passwords hashed with bcrypt (cost 12). Minimum 10 characters.
- TOTP MFA (otplib). Secrets encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`). Mandatory for Owner, Group Admin, General Manager, Property Manager and Accounts Manager: `getCtx()` redirects them to `/security` until enrolled, so no tenant page loads without MFA. Admin can reset a member's MFA (audited, revokes sessions).
- Login throttling: 8 attempts / 15 min per email (covers password and TOTP guesses). **In-memory per instance**; replace with a shared store (Redis/Upstash) before running multiple instances.
- Password reset and invitation tokens: 32 random bytes, only the SHA-256 hash is stored, single use (atomic claim), expiring (reset 1h, verify 48h, invite 72h). Reset responds identically for unknown emails. Reset revokes all sessions.
- Email verification and token consumption happen on POST so link scanners cannot burn tokens.
- Authorization: central permission matrix, enforced in services (not just hidden menus). Owner-level roles can only be assigned by an owner; users cannot change their own role; last active owner is protected; property grants limited to the granter's own properties.
- Audit log is append-only (DB trigger blocks UPDATE/DELETE/TRUNCATE).
- Headers: CSP (currently allows inline scripts/styles for Next hydration; move to nonces), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, HSTS in production.
- Errors returned to users are generic or from a safe allow-list (`toSafeError`); no stack traces or SQL.
- Server actions rely on Next.js's built-in Origin check for CSRF.

## Known gaps / required before pilot
- No MFA recovery codes (recovery is owner-assisted reset).
- Emails are written to `email_outbox`; **no real mail provider yet**. The outbox contains live tokens, so it must not be used in production. Wire a provider and remove token bodies from storage.
- No IP allow-listing or SSO. Sign-in successes and failures (for existing accounts) are written to the audit log and listed under Settings > Users & security; there are no alerts on them yet.
- Dependency scan (`npm audit --omit=dev`, 2026-10-11): the critical Auth.js advisories were fixed by updating next-auth to 5.0.0-beta.32 (@auth/core 0.41.3). Four high advisories remain, all inside the Prisma 7.10 command-line tooling (deepmerge-ts, mysql2), which is used only at build and migration time; the running application uses the PostgreSQL driver adapter and never loads them. The only automated fix is a downgrade to Prisma 6, so it is accepted until Prisma ships a patched 7.x. Re-run the audit before every release.
- No secrets manager integration; env vars only.
- CSP uses `unsafe-inline`.

## Data protection notes
Guest ID numbers can be entered on the booking form: they are stored encrypted (AES-256-GCM) and never read back by any screen yet. Restrict any future display to `guests.viewSensitive` and define retention. Guest feedback comments are visible to `feedback.view`; names, rooms and booking references only to roles that can view guests. Notification provider keys are stored encrypted and never returned to the browser. Auditor role currently sees guest names but not contact details.

## Incident / access-request / retention processes
Not yet documented; to be written with the deployment runbook (see `BACKUP_AND_RECOVERY.md`).
