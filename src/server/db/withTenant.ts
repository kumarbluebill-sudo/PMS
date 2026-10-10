import type { Prisma, PrismaClient } from "@prisma/client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction with the Postgres setting `app.tenant_id` bound,
 * so row-level security policies restrict every query to that tenant.
 * `tenantId` must come from a validated server-side session, never the client.
 */
export async function withTenant<T>(
  db: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("Invalid tenant id");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
