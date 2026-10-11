-- Hosted Postgres (e.g. Supabase) auto-enables RLS on new tables. Tables without a tenant policy
-- (tenants, users, memberships, tokens, audit, outbox) would then deny the runtime role everything.
-- Grant only the runtime role `pms_app` access; other roles (e.g. a provider's public API roles)
-- keep getting no rows. No-op where the role does not exist or RLS is not enabled (local dev).
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['tenants','users','tenant_memberships','user_property_roles',
    'auth_tokens','email_outbox','audit_logs']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policy p
                       WHERE p.polrelid = format('public.%I', t)::regclass AND p.polname = 'app_role_access') THEN
      EXECUTE format('CREATE POLICY app_role_access ON %I FOR ALL TO pms_app USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
  -- Prisma's own bookkeeping table: read-only for the app (the System page shows migration status).
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = '_prisma_migrations' AND c.relrowsecurity)
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public._prisma_migrations'::regclass AND p.polname = 'app_role_read') THEN
    CREATE POLICY app_role_read ON "_prisma_migrations" FOR SELECT TO pms_app USING (true);
  END IF;
END $$;
