-- Prevent overlapping active assignments for the same room (half-open [arrival, departure)).
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE room_assignments
  ADD CONSTRAINT room_assignments_dates_check CHECK (departure > arrival),
  ADD CONSTRAINT room_assignments_no_overlap
  EXCLUDE USING gist (
    "roomId" WITH =,
    daterange(arrival, departure, '[)') WITH &&
  ) WHERE (active);

-- Audit log is append-only.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Row-level security keyed on the per-transaction setting app.tenant_id.
-- FORCE applies policies to the table owner as well; migrations/admin use a BYPASSRLS role.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['properties','room_types','rooms','guests','reservations',
    'reservation_status_history','room_assignments','housekeeping_tasks','maintenance_requests']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
