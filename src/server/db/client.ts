import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Each serverless instance keeps its own small pool. Hosted poolers in session mode allow only a few connections in
 * total (Supabase: 15), so a large default pool per instance exhausts them under modest traffic. Keep pools small and
 * release idle connections quickly. Override with DB_POOL_MAX if the database allows more.
 */
export function createDb(connectionString: string): PrismaClient {
  const max = Math.max(1, Number(process.env.DB_POOL_MAX) || 2);
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 15_000 }),
  });
}

const globalForDb = globalThis as unknown as { db?: PrismaClient };

/** Application connection. Must use a role WITHOUT BYPASSRLS so tenant policies apply. */
export function getDb(): PrismaClient {
  if (!globalForDb.db) {
    const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.db = createDb(url);
  }
  return globalForDb.db;
}
