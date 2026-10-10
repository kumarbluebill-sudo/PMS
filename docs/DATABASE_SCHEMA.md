# Database schema (implemented subset)

Source of truth: `prisma/schema.prisma` + `prisma/migrations/*` (the `constraints` migration holds SQL Prisma cannot express).

| Area | Tables |
|---|---|
| Identity & tenancy | `tenants`, `users`, `tenant_memberships` (role + `extraPermissions`), `properties`, `user_property_roles`, `auth_tokens`, `email_outbox` |
| Inventory | `room_types`, `rooms` (housekeeping status, `outOfOrder`), `room_assignments` |
| Guests & stays | `guests`, `reservations`, `reservation_status_history` |
| Operations | `housekeeping_tasks`, `maintenance_requests` (`blocksRoom`) |
| Compliance | `audit_logs` (append-only) |

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

## Not yet modelled
Folios, invoices, payments, tax rules, accounting, channels, subscriptions, backups, documents, rate plans.
