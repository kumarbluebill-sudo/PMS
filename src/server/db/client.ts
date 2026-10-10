import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export function createDb(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
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
