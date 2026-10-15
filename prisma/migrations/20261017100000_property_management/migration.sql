-- Property management: profile fields, archive flags, rate plans and frozen booking rates. Additive only.

ALTER TABLE "properties"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "logoUrl" TEXT,
  ADD COLUMN "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "operationalAddress" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "properties" ADD CONSTRAINT "properties_status_check" CHECK ("status" IN ('ACTIVE','INACTIVE','ARCHIVED'));
CREATE UNIQUE INDEX "properties_tenantId_code_key" ON "properties"("tenantId", lower("code")) WHERE "code" IS NOT NULL;

ALTER TABLE "room_types"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "room_types_propertyId_code_key" ON "room_types"("propertyId", lower("code")) WHERE "code" IS NOT NULL;

ALTER TABLE "rooms"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "reservations" ADD COLUMN "rateSnapshot" JSONB, ADD COLUMN "ratePlanId" UUID;

-- Freeze today's prices on bookings that can still be posted, so a later rate edit cannot reprice them.
-- Nothing visible changes: each booking keeps the nightly rate and extra-person rates in force right now.
UPDATE "reservations" r
SET "agreedRateMinor" = COALESCE(r."agreedRateMinor", t."baseRateMinor"),
    "rateSnapshot" = jsonb_build_object('extraAdultMinor', t."extraAdultRateMinor", 'extraChildMinor', t."extraChildRateMinor", 'baseOccupancy', t."baseOccupancy")
FROM "room_types" t
WHERE t."id" = r."roomTypeId" AND r."status" IN ('TENTATIVE','CONFIRMED','CHECKED_IN');

CREATE TABLE "rate_plans" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "validFrom" DATE,
  "validTo" DATE,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "weekendDays" INTEGER[] NOT NULL DEFAULT ARRAY[5, 6],
  "mealPlan" TEXT NOT NULL DEFAULT 'ROOM_ONLY',
  "refundable" BOOLEAN NOT NULL DEFAULT true,
  "minStay" INTEGER,
  "maxStay" INTEGER,
  "taxNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rate_plans_dates_check" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom"),
  CONSTRAINT "rate_plans_meal_check" CHECK ("mealPlan" IN ('ROOM_ONLY','BREAKFAST','HALF_BOARD','FULL_BOARD')),
  CONSTRAINT "rate_plans_stay_check" CHECK (("minStay" IS NULL OR "minStay" >= 1) AND ("maxStay" IS NULL OR "maxStay" >= 1) AND ("minStay" IS NULL OR "maxStay" IS NULL OR "maxStay" >= "minStay"))
);
CREATE UNIQUE INDEX "rate_plans_propertyId_code_key" ON "rate_plans"("propertyId", "code");
CREATE INDEX "rate_plans_tenantId_propertyId_idx" ON "rate_plans"("tenantId", "propertyId");
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "rate_plan_rates" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "ratePlanId" UUID NOT NULL,
  "roomTypeId" UUID NOT NULL,
  "weekdayRateMinor" INTEGER NOT NULL,
  "weekendRateMinor" INTEGER,
  "singleOccupancyRateMinor" INTEGER,
  "extraAdultRateMinor" INTEGER,
  "extraChildRateMinor" INTEGER,
  CONSTRAINT "rate_plan_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rate_plan_rates_nonneg_check" CHECK ("weekdayRateMinor" >= 0 AND COALESCE("weekendRateMinor", 0) >= 0 AND COALESCE("singleOccupancyRateMinor", 0) >= 0 AND COALESCE("extraAdultRateMinor", 0) >= 0 AND COALESCE("extraChildRateMinor", 0) >= 0)
);
CREATE UNIQUE INDEX "rate_plan_rates_ratePlanId_roomTypeId_key" ON "rate_plan_rates"("ratePlanId", "roomTypeId");
CREATE INDEX "rate_plan_rates_tenantId_idx" ON "rate_plan_rates"("tenantId");
ALTER TABLE "rate_plan_rates" ADD CONSTRAINT "rate_plan_rates_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "rate_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rate_plan_rates" ADD CONSTRAINT "rate_plan_rates_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_plans
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE rate_plan_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plan_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_plan_rates
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_plans, rate_plan_rates TO pms_app;
  END IF;
END $$;
