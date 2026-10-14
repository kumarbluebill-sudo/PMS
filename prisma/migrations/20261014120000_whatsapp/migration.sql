CREATE TABLE "message_templates" (
  "id" UUID NOT NULL, "tenantId" UUID NOT NULL, "propertyId" UUID NOT NULL,
  "key" TEXT NOT NULL, "body" TEXT NOT NULL, "contentSid" TEXT, "active" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "message_templates_propertyId_key_key" ON "message_templates"("propertyId", "key");
CREATE INDEX "message_templates_tenantId_idx" ON "message_templates"("tenantId");

CREATE TABLE "guest_consents" (
  "id" UUID NOT NULL, "tenantId" UUID NOT NULL, "guestId" UUID NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'WHATSAPP', "status" TEXT NOT NULL, "source" TEXT NOT NULL,
  "recordedBy" UUID NOT NULL, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guest_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guest_consents_status_check" CHECK ("status" IN ('GRANTED','REVOKED'))
);
CREATE UNIQUE INDEX "guest_consents_guestId_channel_key" ON "guest_consents"("guestId", "channel");
CREATE INDEX "guest_consents_tenantId_idx" ON "guest_consents"("tenantId");

CREATE TABLE "message_logs" (
  "id" UUID NOT NULL, "tenantId" UUID NOT NULL, "propertyId" UUID NOT NULL, "guestId" UUID NOT NULL,
  "reservationId" UUID, "templateKey" TEXT NOT NULL, "toMasked" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "providerMessageId" TEXT, "status" TEXT NOT NULL, "error" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT NOT NULL, "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_logs_status_check" CHECK ("status" IN ('PENDING','SENT','DELIVERED','FAILED','TEST'))
);
CREATE UNIQUE INDEX "message_logs_propertyId_idempotencyKey_key" ON "message_logs"("propertyId", "idempotencyKey");
CREATE INDEX "message_logs_tenantId_propertyId_createdAt_idx" ON "message_logs"("tenantId", "propertyId", "createdAt");
CREATE INDEX "message_logs_providerMessageId_idx" ON "message_logs"("providerMessageId");

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY; ALTER TABLE message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_templates USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE guest_consents ENABLE ROW LEVEL SECURITY; ALTER TABLE guest_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guest_consents USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE message_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_logs USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON message_templates, guest_consents, message_logs TO pms_app;
  END IF;
END $$;
