import { execSync } from "node:child_process";
import { Client } from "pg";
import "dotenv/config";

export const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pms:pms_dev_password@localhost:5432/pms_test";

/** Applies migrations to the test DB and creates a non-superuser app role so RLS is exercised. */
export default async function setup() {
  execSync("npx prisma migrate deploy", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: ADMIN_URL },
  });
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pms_app') THEN
      CREATE ROLE pms_app LOGIN PASSWORD 'pms_app_pw' NOSUPERUSER NOBYPASSRLS;
    END IF; END $$;`);
  await c.query(`GRANT USAGE ON SCHEMA public TO pms_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app;`);
  await c.end();
}
