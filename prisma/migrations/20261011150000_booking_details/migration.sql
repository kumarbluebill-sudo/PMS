-- Booking details for the simplified reservation form (all additive/nullable).
ALTER TABLE "reservations"
  ADD COLUMN "groupRef" TEXT,
  ADD COLUMN "companyName" TEXT,
  ADD COLUMN "agentName" TEXT,
  ADD COLUMN "ratePlan" TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "agreedRateMinor" INTEGER,
  ADD COLUMN "discountReason" TEXT,
  ADD COLUMN "quotedTotalMinor" INTEGER,
  ADD CONSTRAINT "reservations_agreed_rate_check" CHECK ("agreedRateMinor" IS NULL OR "agreedRateMinor" >= 0);
CREATE INDEX "reservations_tenantId_groupRef_idx" ON "reservations"("tenantId", "groupRef");

ALTER TABLE "guests"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "idType" TEXT,
  ADD COLUMN "idNumberEnc" TEXT;
