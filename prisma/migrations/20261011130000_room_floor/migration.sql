-- Room floor for the room board filters (nullable: existing rooms are unaffected).
ALTER TABLE "rooms" ADD COLUMN "floor" INTEGER;
