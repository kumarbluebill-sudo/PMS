import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { audit } from "./audit";

export const guestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(1000).optional(),
});

export async function createGuest(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "guests.manage");
  const d = guestSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const g = await tx.guest.create({ data: { ...d, tenantId: ctx.tenantId } });
    await audit(tx, ctx, { action: "guest.create", entityType: "Guest", entityId: g.id });
    return g;
  });
}

export async function searchGuests(db: PrismaClient, ctx: Ctx, q = "") {
  authorize(ctx, "guests.view");
  const canSeeContact = ctx.role !== "AUDITOR";
  const rows = await withTenant(db, ctx.tenantId, (tx) =>
    tx.guest.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] } : {},
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  );
  return rows.map((g) => (canSeeContact ? g : { ...g, phone: null, email: null, notes: null }));
}
