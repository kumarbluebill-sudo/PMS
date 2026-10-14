-- Buildings, floors, room layout and richer room categories. Additive; Room.floor (int) is kept.
ALTER TABLE "room_types" ADD COLUMN "description" TEXT, ADD COLUMN "bedConfig" TEXT, ADD COLUMN "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "buildings" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "buildings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buildings_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "buildings_propertyId_name_key" ON "buildings"("propertyId", "name");
CREATE INDEX "buildings_tenantId_propertyId_idx" ON "buildings"("tenantId", "propertyId");

CREATE TABLE "floors" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "buildingId" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "level" INTEGER NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "floors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "floors_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "floors_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "floors_buildingId_label_key" ON "floors"("buildingId", "label");
CREATE INDEX "floors_tenantId_propertyId_idx" ON "floors"("tenantId", "propertyId");

ALTER TABLE "rooms" ADD COLUMN "buildingId" UUID, ADD COLUMN "floorId" UUID, ADD COLUMN "layoutX" INTEGER, ADD COLUMN "layoutY" INTEGER;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "floors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_layout_check" CHECK (("layoutX" IS NULL) = ("layoutY" IS NULL) AND ("layoutX" IS NULL OR ("layoutX" >= 0 AND "layoutY" >= 0)));
CREATE INDEX "rooms_floorId_idx" ON "rooms"("floorId");

ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON buildings
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE floors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON floors
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON buildings, floors TO pms_app;
  END IF;
END $$;

-- Backfill: one "Main Building" per property that has rooms, and a floor per distinct Room.floor value.
INSERT INTO buildings ("id", "tenantId", "propertyId", "name")
SELECT gen_random_uuid(), "tenantId", "propertyId", 'Main Building' FROM rooms GROUP BY "tenantId", "propertyId";

INSERT INTO floors ("id", "tenantId", "propertyId", "buildingId", "label", "level", "sortOrder")
SELECT gen_random_uuid(), r."tenantId", r."propertyId", b."id",
       CASE WHEN r."floor" IS NULL THEN 'Unassigned' WHEN r."floor" = 0 THEN 'Ground' ELSE 'Floor ' || r."floor" END,
       COALESCE(r."floor", 0), COALESCE(r."floor", 0)
FROM (SELECT DISTINCT "tenantId", "propertyId", "floor" FROM rooms) r
JOIN buildings b ON b."propertyId" = r."propertyId";

UPDATE rooms r SET "buildingId" = f."buildingId", "floorId" = f."id"
FROM floors f
WHERE f."propertyId" = r."propertyId"
  AND f."level" = COALESCE(r."floor", 0)
  AND f."label" = CASE WHEN r."floor" IS NULL THEN 'Unassigned' WHEN r."floor" = 0 THEN 'Ground' ELSE 'Floor ' || r."floor" END;
