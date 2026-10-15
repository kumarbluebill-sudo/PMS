import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { withTenant } from "@/server/db/withTenant";
import { startTrial } from "./subscription";

export const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  propertyName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  /** Plan chosen on the pricing page; the platform default is used when absent or unknown. */
  plan: z.string().trim().max(40).optional(),
});

/** Creates tenant + owner user + first property atomically. */
export async function registerTenant(db: PrismaClient, input: unknown) {
  const d = registerSchema.parse(input);
  if (await db.user.findUnique({ where: { email: d.email } })) {
    throw new AppError("CONFLICT", "An account with this email already exists.");
  }
  const passwordHash = await bcrypt.hash(d.password, 12);
  const { tenant, user } = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { legalName: d.businessName, displayName: d.businessName } });
    const user = await tx.user.create({ data: { email: d.email, name: d.name, passwordHash } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "HOTEL_OWNER" } });
    await tx.auditLog.create({
      data: { tenantId: tenant.id, actorId: user.id, action: "tenant.register", entityType: "Tenant", entityId: tenant.id },
    });
    return { tenant, user };
  });
  const property = await withTenant(db, tenant.id, async (tx) => {
    await startTrial(tx, tenant.id, d.plan);
    return tx.property.create({ data: { tenantId: tenant.id, name: d.propertyName } });
  });
  return { tenantId: tenant.id, userId: user.id, propertyId: property.id };
}

export async function verifyCredentials(db: PrismaClient, email: string, password: string) {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  // Compare against a dummy hash when the user is missing to keep timing similar.
  const hash = user?.passwordHash ?? "$2b$12$CwTycUXWue0Thq9StjUM0uJ8e0fYk1c1fQ5q4m9m6s0q8v7kq1v2e";
  const ok = await bcrypt.compare(password, hash);
  return ok && user?.active ? user : null;
}
