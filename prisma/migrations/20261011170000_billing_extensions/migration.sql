-- Company / split folios, finer charge reporting split, and extra-person rates.
DROP INDEX "folios_reservationId_key";
ALTER TABLE "folios"
  ADD COLUMN "label" TEXT NOT NULL DEFAULT 'GUEST',
  ADD COLUMN "billTo" TEXT,
  ADD CONSTRAINT "folios_label_check" CHECK ("label" IN ('GUEST','COMPANY'));
CREATE UNIQUE INDEX "folios_reservationId_label_key" ON "folios"("reservationId", "label");

ALTER TABLE "folio_entries" ADD COLUMN "subCategory" TEXT;

ALTER TABLE "room_types"
  ADD COLUMN "baseOccupancy" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "extraAdultRateMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "extraChildRateMinor" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "room_types_extra_rates_check" CHECK ("extraAdultRateMinor" >= 0 AND "extraChildRateMinor" >= 0 AND "baseOccupancy" >= 1);
