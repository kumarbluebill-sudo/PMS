ALTER TABLE "reservations"
  ADD COLUMN "vip" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "etaTime" TEXT,
  ADD COLUMN "earlyCheckinRequest" TEXT,
  ADD COLUMN "lateCheckoutRequest" TEXT,
  ADD COLUMN "registrationCompletedAt" TIMESTAMP(3),
  ADD COLUMN "idVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "idVerifiedBy" UUID,
  ADD COLUMN "noShowAt" TIMESTAMP(3);

CREATE TABLE "alert_acks" (
  "id" UUID NOT NULL, "tenantId" UUID NOT NULL, "propertyId" UUID NOT NULL,
  "alertKey" TEXT NOT NULL, "status" TEXT NOT NULL, "note" TEXT, "by" UUID NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_acks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alert_acks_status_check" CHECK ("status" IN ('ACKNOWLEDGED','RESOLVED'))
);
CREATE UNIQUE INDEX "alert_acks_propertyId_alertKey_key" ON "alert_acks"("propertyId", "alertKey");
CREATE INDEX "alert_acks_tenantId_propertyId_idx" ON "alert_acks"("tenantId", "propertyId");

ALTER TABLE alert_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_acks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_acks
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON alert_acks TO pms_app;
  END IF;
END $$;
