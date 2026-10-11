-- Out-of-order / maintenance block details and an append-only room status history.
ALTER TABLE "maintenance_requests"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'REPORT',
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "reportedBy" UUID,
  ADD COLUMN "startDate" DATE,
  ADD COLUMN "expectedResolution" DATE,
  ADD COLUMN "assignedTo" UUID,
  ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approvedBy" UUID,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "resolutionNote" TEXT,
  ADD COLUMN "resolvedBy" UUID,
  ADD CONSTRAINT "maintenance_mode_check" CHECK ("mode" IN ('REPORT','MAINTENANCE_BLOCK','OUT_OF_ORDER')),
  ADD CONSTRAINT "maintenance_priority_check" CHECK ("priority" IN ('LOW','NORMAL','HIGH','URGENT')),
  ADD CONSTRAINT "maintenance_category_check" CHECK ("category" IN
    ('PLUMBING','ELECTRICAL','AIR_CONDITIONING','FURNITURE_DAMAGE','BATHROOM','RENOVATION','SAFETY','CLEANING','OTHER')),
  ADD CONSTRAINT "maintenance_window_check" CHECK ("expectedResolution" IS NULL OR "startDate" IS NULL OR "expectedResolution" >= "startDate");

UPDATE "maintenance_requests" SET "reportedAt" = "createdAt", "mode" = CASE WHEN "blocksRoom" THEN 'MAINTENANCE_BLOCK' ELSE 'REPORT' END;

CREATE TABLE "room_status_history" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "fromState" TEXT,
  "toState" TEXT NOT NULL,
  "reason" TEXT,
  "maintenanceId" UUID,
  "changedBy" UUID NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_status_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "room_status_history_tenantId_roomId_changedAt_idx" ON "room_status_history"("tenantId", "roomId", "changedAt");
ALTER TABLE "room_status_history" ADD CONSTRAINT "room_status_history_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only (forbid_change() is defined by the billing migration) and tenant-isolated.
CREATE TRIGGER room_status_history_immutable BEFORE UPDATE OR DELETE ON room_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER room_status_history_no_truncate BEFORE TRUNCATE ON room_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
ALTER TABLE room_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_status_history
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Hosted databases grant per table: give the runtime role what it needs (no-op where the role is absent).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT ON room_status_history TO pms_app;
  END IF;
END $$;
