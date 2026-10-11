-- Guest feedback, internal follow-up notes and expiring feedback links.
CREATE TABLE "feedback" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "reservationId" UUID,
  "roomTypeId" UUID,
  "guestName" TEXT NOT NULL,
  "roomNumber" TEXT,
  "arrival" DATE,
  "departure" DATE,
  "overall" INTEGER NOT NULL,
  "cleanliness" INTEGER,
  "service" INTEGER,
  "food" INTEGER,
  "facilities" INTEGER,
  "comments" TEXT,
  "recommend" BOOLEAN,
  "suggestions" TEXT,
  "source" TEXT NOT NULL DEFAULT 'STAFF',
  "status" TEXT NOT NULL DEFAULT 'NONE',
  "submittedBy" UUID,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feedback_ratings_check" CHECK (
    "overall" BETWEEN 1 AND 5
    AND ("cleanliness" IS NULL OR "cleanliness" BETWEEN 1 AND 5)
    AND ("service" IS NULL OR "service" BETWEEN 1 AND 5)
    AND ("food" IS NULL OR "food" BETWEEN 1 AND 5)
    AND ("facilities" IS NULL OR "facilities" BETWEEN 1 AND 5)),
  CONSTRAINT "feedback_source_check" CHECK ("source" IN ('STAFF','LINK')),
  CONSTRAINT "feedback_status_check" CHECK ("status" IN ('NONE','OPEN','IN_PROGRESS','RESOLVED'))
);
CREATE INDEX "feedback_tenantId_propertyId_submittedAt_idx" ON "feedback"("tenantId", "propertyId", "submittedAt");
CREATE INDEX "feedback_tenantId_reservationId_idx" ON "feedback"("tenantId", "reservationId");
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "feedback_notes" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "feedbackId" UUID NOT NULL,
  "note" TEXT NOT NULL,
  "authorId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_notes_tenantId_feedbackId_idx" ON "feedback_notes"("tenantId", "feedbackId");
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_feedbackId_fkey"
  FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "feedback_links" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "propertyId" UUID NOT NULL,
  "reservationId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "feedback_links_tokenHash_key" ON "feedback_links"("tokenHash");
CREATE INDEX "feedback_links_tenantId_reservationId_idx" ON "feedback_links"("tenantId", "reservationId");
ALTER TABLE "feedback_links" ADD CONSTRAINT "feedback_links_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity: the guest's feedback never changes except its complaint status; notes are append-only;
-- a link can only be marked used, once.
CREATE OR REPLACE FUNCTION feedback_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'feedback cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'feedback is immutable; only its status can change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER feedback_guard BEFORE UPDATE OR DELETE ON feedback FOR EACH ROW EXECUTE FUNCTION feedback_guard();

CREATE OR REPLACE FUNCTION feedback_link_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'feedback links cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'usedAt') <> (to_jsonb(OLD) - 'usedAt') THEN
    RAISE EXCEPTION 'feedback links are immutable except for being used';
  END IF;
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION 'feedback link already used';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER feedback_link_guard BEFORE UPDATE OR DELETE ON feedback_links FOR EACH ROW EXECUTE FUNCTION feedback_link_guard();

CREATE TRIGGER feedback_notes_immutable BEFORE UPDATE OR DELETE ON feedback_notes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER feedback_notes_no_truncate BEFORE TRUNCATE ON feedback_notes
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feedback','feedback_notes','feedback_links']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
  -- Hosted databases grant per table (no-op where the runtime role does not exist yet).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON feedback, feedback_links TO pms_app;
    GRANT SELECT, INSERT ON feedback_notes TO pms_app;
  END IF;
END $$;
