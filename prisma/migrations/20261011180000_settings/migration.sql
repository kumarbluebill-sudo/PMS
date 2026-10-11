-- Typed settings (property and tenant scope). Validated in application code against a catalogue.
CREATE TABLE "settings" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedBy" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "settings_scope_check" CHECK ("scope" IN ('PROPERTY','TENANT'))
);
CREATE UNIQUE INDEX "settings_tenantId_scope_scopeId_key_key" ON "settings"("tenantId", "scope", "scopeId", "key");

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settings
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Hosted databases grant per table (no-op where the runtime role does not exist yet).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON settings TO pms_app;
  END IF;
END $$;
