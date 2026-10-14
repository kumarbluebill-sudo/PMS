-- One room per floor-plan cell.
CREATE UNIQUE INDEX "rooms_floor_cell_key" ON "rooms"("floorId", "layoutX", "layoutY") WHERE "layoutX" IS NOT NULL AND "floorId" IS NOT NULL;

CREATE TABLE "onboarding_states" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "step" INTEGER NOT NULL DEFAULT 0,
  "data" JSONB NOT NULL DEFAULT '{}',
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "onboarding_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "onboarding_states_propertyId_key" ON "onboarding_states"("propertyId");
CREATE INDEX "onboarding_states_tenantId_idx" ON "onboarding_states"("tenantId");

ALTER TABLE onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onboarding_states
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON onboarding_states TO pms_app;
  END IF;
END $$;
