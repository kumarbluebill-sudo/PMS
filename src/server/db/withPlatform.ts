import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Runs `fn` in a transaction that may read subscription tables across all hotels. Only platform code (the provider's
 * console and the daily job) calls this, after its own authorisation check; hotel requests use withTenant, which
 * never sets this flag, so row-level security keeps every hotel to its own rows.
 */
export async function withPlatform<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'on', true)`;
      return fn(tx);
    },
    { maxWait: 20_000, timeout: 60_000 },
  );
}
