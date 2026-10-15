-- Additive: OTA/channel reference on reservations, and a reason on status history.
ALTER TABLE "reservations" ADD COLUMN "externalRef" TEXT;
ALTER TABLE "reservation_status_history" ADD COLUMN "reason" TEXT;
CREATE INDEX "reservations_tenantId_externalRef_idx" ON "reservations"("tenantId", "externalRef");
