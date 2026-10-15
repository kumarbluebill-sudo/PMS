-- Guest recognition, checkout record, housekeeping tasks and in-app notifications. Additive only.

-- Guests: a searchable phone key (last 10 digits) beside the phone exactly as typed, plus profile fields.
ALTER TABLE "guests"
  ADD COLUMN "phoneKey" TEXT,
  ADD COLUMN "nationality" TEXT,
  ADD COLUMN "preferences" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "guests"
SET "phoneKey" = NULLIF(right(regexp_replace("phone", '\D', '', 'g'), 10), '')
WHERE "phone" IS NOT NULL AND length(regexp_replace("phone", '\D', '', 'g')) >= 4;
CREATE INDEX "guests_tenantId_phoneKey_idx" ON "guests"("tenantId", "phoneKey");

-- Reservations: when and by whom the guest actually left.
ALTER TABLE "reservations" ADD COLUMN "actualDeparture" TIMESTAMP(3), ADD COLUMN "checkedOutBy" UUID;
UPDATE "reservations" r
SET "actualDeparture" = h."changedAt", "checkedOutBy" = h."changedBy"
FROM (
  SELECT DISTINCT ON ("reservationId") "reservationId", "changedAt", "changedBy"
  FROM "reservation_status_history" WHERE "toStatus" = 'CHECKED_OUT' ORDER BY "reservationId", "changedAt" DESC
) h
WHERE h."reservationId" = r."id" AND r."status" = 'CHECKED_OUT';

-- Rooms: Do Not Disturb is its own flag, separate from cleaning, occupancy and maintenance.
ALTER TABLE "rooms" ADD COLUMN "dnd" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "dndAt" TIMESTAMP(3);

-- Housekeeping tasks: priority, assignment trail, inspection, and a version for conflict detection.
ALTER TABLE "housekeeping_tasks"
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "reservationId" UUID,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "inspectionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "inspectedBy" UUID,
  ADD COLUMN "inspectedAt" TIMESTAMP(3),
  ADD COLUMN "inspectionResult" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedBy" UUID,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_priority_check" CHECK ("priority" IN ('NORMAL','HIGH','URGENT'));
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_status_check" CHECK ("status" IN ('PENDING','IN_PROGRESS','AWAITING_INSPECTION','DONE','INSPECTED','CANCELLED'));
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_result_check" CHECK ("inspectionResult" IS NULL OR "inspectionResult" IN ('PASSED','FAILED'));
CREATE INDEX "housekeeping_tasks_roomId_idx" ON "housekeeping_tasks"("roomId");

-- In-app notifications. The dedupe key stops the same event notifying twice.
CREATE TABLE "app_notifications" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "href" TEXT,
  "audiencePerm" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "app_notifications_propertyId_dedupeKey_key" ON "app_notifications"("propertyId", "dedupeKey");
CREATE INDEX "app_notifications_tenantId_propertyId_createdAt_idx" ON "app_notifications"("tenantId", "propertyId", "createdAt");

CREATE TABLE "notification_reads" (
  "notificationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("notificationId", "userId")
);
CREATE INDEX "notification_reads_tenantId_userId_idx" ON "notification_reads"("tenantId", "userId");
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "app_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE app_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_notifications
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_reads
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON app_notifications TO pms_app;
    GRANT SELECT, INSERT ON notification_reads TO pms_app;
  END IF;
END $$;
