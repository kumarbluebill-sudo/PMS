import "dotenv/config";
import { Client } from "pg";

/** End-to-end hotels start on the unlimited plan unless a test picks another, so plan limits do not get in the way. */
export default async function setup() {
  const c = new Client({ connectionString: process.env.DATABASE_URL?.replace(/\?schema=\w+$/, "") });
  await c.connect();
  await c.query(`INSERT INTO platform_settings ("key", "value", "updatedAt") VALUES ('saas.defaultPlanCode', '"enterprise"', now())
    ON CONFLICT ("key") DO UPDATE SET "value" = '"enterprise"'`);
  await c.end();
}
