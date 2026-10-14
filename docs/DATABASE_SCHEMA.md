# Database schema (implemented subset)

Source of truth: `prisma/schema.prisma` + `prisma/migrations/*` (the `constraints` migration holds SQL Prisma cannot express).

| Area | Tables |
|---|---|
| Identity & tenancy | `tenants`, `users`, `tenant_memberships` (role + `extraPermissions`), `properties`, `user_property_roles`, `auth_tokens`, `email_outbox` |
| Inventory | `room_types`, `rooms` (housekeeping status, `outOfOrder`), `room_assignments` |
| Guests & stays | `guests`, `reservations`, `reservation_status_history` |
| Operations | `housekeeping_tasks`, `maintenance_requests` (`blocksRoom`) |
| Compliance | `audit_logs` (append-only) |
| Billing | `folios`, `folio_entries` (append-only ledger), `payments`, `refunds`, `cash_shifts` |
| Tax & invoicing | `tax_rules`, `invoice_sequences`, `invoices`, `invoice_lines` |
| Accounting | `accounts`, `journal_entries`, `journal_lines` |

## Conventions
- UUID primary keys. Money is integer minor units (`baseRateMinor`, paise).
- Stay dates are `DATE` with half-open semantics `[arrival, departure)`.
- Every tenant-owned table carries `tenantId`; property-scoped tables also `propertyId`.
- Status values are strings validated in the application (state machine in `src/server/domain/stay.ts`).

## Database-enforced guarantees (tested)
- `room_assignments_no_overlap`: no two active assignments of a room overlap.
- `room_assignments_dates_check`: departure after arrival.
- `audit_logs` rejects UPDATE/DELETE/TRUNCATE.
- RLS policy `tenant_isolation` on properties, room_types, rooms, guests, reservations, reservation_status_history, room_assignments, housekeeping_tasks, maintenance_requests.

## Roles
Migrations run as an admin role. The app connects as `pms_app` (no superuser, no BYPASSRLS) with table-level DML grants. New tables need `GRANT` (dev DB sets default privileges; test setup re-grants).

## Billing guarantees (tested)
- `folio_entries`, `payments`, `refunds`, `invoices`, `invoice_lines`, `journal_*` reject UPDATE/DELETE/TRUNCATE.
- Approved/retired `tax_rules` cannot change economic terms (trigger); only drafts can be deleted.
- A journal entry must balance at commit (deferred constraint trigger); each journal line is debit XOR credit.
- `invoice_lines.folioEntryId` is unique, so a charge can be on one document only; `folio_entries.reversesEntryId` is unique, so a line can be credited once.
- `payments` and `folio_entries` carry unique idempotency keys per tenant.
- `folio_entries.balanceDeltaMinor` is the signed effect on the amount owed: balance = SUM over the folio.
- Money columns are 32-bit integers (paise); the app caps single amounts well below that.
- Same RLS tenant policy on all new tables.

## Not yet modelled
Debit notes, advance receipts, folio transfers, expenses/suppliers, channels, subscriptions, backups, documents, rate plans.

## Added 2026-10-14
`buildings`, `floors` (deactivate-only; unique name per property / label per building), `rooms.buildingId/floorId/layoutX/layoutY` (unique cell per floor, both coordinates set or both null), `room_types.description/bedConfig/amenities`, `onboarding_states` (one row per property), `message_templates`, `guest_consents` (one per guest and channel, GRANTED or REVOKED), `message_logs` (no message text or full phone number; unique idempotency key per property). All have the same tenant RLS policy and grants to `pms_app`.
