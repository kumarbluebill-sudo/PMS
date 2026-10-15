-- Email delivery: the outbox records who it was for, which provider took it, and what really happened. Additive only.
ALTER TABLE "email_outbox"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "reservationId" UUID,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ACCOUNT',
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "providerId" TEXT,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "sentAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_status_check" CHECK ("status" IN ('QUEUED','ACCEPTED','DELIVERED','BOUNCED','FAILED','TEST','SENT'));
CREATE INDEX "email_outbox_tenantId_reservationId_idx" ON "email_outbox"("tenantId", "reservationId");
CREATE UNIQUE INDEX "email_outbox_idempotencyKey_key" ON "email_outbox"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "email_outbox_providerId_idx" ON "email_outbox"("providerId");

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON email_outbox TO pms_app;
  END IF;
END $$;
