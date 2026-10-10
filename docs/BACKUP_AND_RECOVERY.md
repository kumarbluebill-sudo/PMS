# Backup and recovery (plan; nothing implemented or tested yet)

Status: **not implemented.** No backup has been taken or restored by this project.

## Plan
- Use the managed provider's automated daily backups and point-in-time recovery; verify the plan includes PITR.
- Targets to confirm with the business: RPO <= 15 min (PITR), RTO <= 4 h.
- Periodic logical dump (`pg_dump`) to separate encrypted object storage with separate credentials.
- Monthly restore test into a scratch database, recorded (date, backup id, row-count and constraint checks).
- A backup is "verified" only after a restore test succeeds.

## Runbooks to write once deployed
Database failure; accidental deletion (PITR to a new instance and copy rows back); bad deployment (Vercel rollback, never roll back a migration without a plan); loss of `APP_ENCRYPTION_KEY` (MFA secrets become unreadable - members must re-enrol, so store the key in a secret manager with backup).

## Data note
`audit_logs` is append-only inside the database but a database admin can still alter it; export it to external storage for tamper evidence in a later phase.
