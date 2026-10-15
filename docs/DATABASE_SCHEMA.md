# Database schema (implemented subset)

Source of truth: `prisma/schema.prisma` + `prisma/migrations/*` (the `constraints` migration holds SQL Prisma cannot express).

| Area | Tables |
|---|---|
| Identity & tenancy | `tenants`, `users`, `tenant_memberships` (role + `extraPermissions`), `properties`, `user_property_roles`, `auth_tokens`, `email_outbox` |
| Inventory | `room_types` (`code`, `active`, `imageUrls`), `rooms` (housekeeping status, `outOfOrder`, `active`/`archivedAt`, `name`), `room_assignments`, `buildings`, `floors` |
| Rates | `rate_plans`, `rate_plan_rates` (see `docs/RATES.md`); `reservations.rateSnapshot` and `ratePlanId` freeze the booked price |
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

## Added 2026-10-15
`reservations`: `vip`, `etaTime`, `earlyCheckinRequest`, `lateCheckoutRequest`, `registrationCompletedAt`, `idVerifiedAt`, `idVerifiedBy`, `noShowAt`. `alert_acks` (one acknowledgement or resolution per property and alert key; alerts themselves are computed from live data). Same tenant RLS policy and grants as other tables.

## Property management (2026-10-17)
- Migration `20261017100000_property_management` is additive. `properties` gain `code`, `phone`, `email`, `description`, `amenities`, `logoUrl`, `imageUrls`, `operationalAddress` and `status` (ACTIVE, INACTIVE, ARCHIVED). `room_types` and `rooms` gain `active` and `updatedAt`; rooms also `name`, `archivedAt`, `notes`.
- Partial unique indexes: property code per business and category code per property, case-insensitive, only where the code is set. Room numbers stay unique per property, archived rooms included.
- `rate_plans` and `rate_plan_rates` carry tenant RLS and `pms_app` grants; checks keep dates, stay limits, meal plan and amounts valid.
- The migration backfills `reservations.agreedRateMinor` and `rateSnapshot` for open bookings so later rate edits cannot reprice them.
- Nothing is deleted by cascade except a plan's own rate lines. Rooms, categories, floors, buildings, plans and properties are archived or deactivated; permanent deletion is allowed only when nothing references the record (`services/property.ts`).

## Guests, checkout and housekeeping (2026-10-18)
- Migration `20261018100000_guest_checkout_housekeeping` is additive. `guests` gain `phoneKey` (last 10 digits, indexed with tenant, backfilled), `nationality`, `preferences`, `updatedAt`; `phone` keeps the number as typed.
- `reservations` gain `actualDeparture` and `checkedOutBy` (backfilled from the status history for past checkouts).
- `rooms` gain `dnd` and `dndAt`.
- `housekeeping_tasks` gain `priority`, `reservationId`, `note`, `startedAt`, `inspectionRequestedAt`, `inspectedBy`, `inspectedAt`, `inspectionResult`, `updatedAt`, `updatedBy`, `version`, with checks on priority, status and inspection result.
- New `app_notifications` (unique `(propertyId, dedupeKey)`) and `notification_reads`, both with tenant RLS and `pms_app` grants.

## Email delivery (2026-10-19)
Migration `20261019100000_email_delivery` is additive. `email_outbox` gains `tenantId`, `reservationId`, `kind` (ACCOUNT or CONFIRMATION), `provider`, `providerId`, `error`, `idempotencyKey` (unique when set), `sentAt`, `deliveredAt`, and a status check: QUEUED, ACCEPTED, DELIVERED, BOUNCED, FAILED, TEST (SENT is the old value). The table has no row-level security because account emails are written before anyone is signed in; staff queries always filter by `tenantId`.
