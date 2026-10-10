# Channel integrations (design notes for Phase 4; nothing implemented)

No OTA or channel-manager connection exists. The core PMS works without any.

## Plan
- Provider-independent interface (connect, fetchReservations, pushAvailability/Rates/Restrictions, acknowledgeReservation, reconcileInventory, getConnectionStatus).
- Ship a clearly labelled mock/sandbox adapter for tests; the UI must show "not connected" until real credentials and partner approval exist. Never simulate successful OTA sync.
- Inbound events idempotent (dedupe key), webhooks signature-verified, retries with exponential backoff, dead-letter after repeated failure, credentials encrypted server-side (reuse `src/server/crypto.ts`).
- Inventory writes go through the same room-assignment constraint as direct bookings, so channels cannot oversell the same room.
- Research each provider's official partner documentation before building a real adapter.
