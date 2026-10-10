/**
 * Starts a local PostgreSQL via embedded-postgres (for machines without Docker).
 * Data lives in .pgdata/ (git-ignored). Creates `pms` and `pms_test` databases.
 * Usage: npm run db:start
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const dataDir = ".pgdata";
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "pms",
  password: "pms_dev_password",
  port: 5432,
  persistent: true,
});

async function main() {
  const fresh = !existsSync(`${dataDir}/PG_VERSION`);
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) {
    await pg.createDatabase("pms");
    await pg.createDatabase("pms_test");
  }
  console.log("Postgres ready on localhost:5432 (Ctrl+C to stop)");
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
