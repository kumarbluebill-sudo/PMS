import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";

export const WIZARD_STEPS = ["Hotel profile", "Buildings & floors", "Room categories", "Room inventory", "Floor plan", "Review & finish"] as const;
const LAST = WIZARD_STEPS.length - 1;

export async function getOnboarding(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const state =
      (await tx.onboardingState.findUnique({ where: { propertyId } })) ??
      (await tx.onboardingState.create({ data: { tenantId: ctx.tenantId, propertyId } }));
    const [property, buildings, floors, types, rooms, placed] = await Promise.all([
      tx.property.findFirstOrThrow({ where: { id: propertyId } }),
      tx.building.count({ where: { propertyId, active: true } }),
      tx.floor.count({ where: { propertyId, active: true } }),
      tx.roomType.count({ where: { propertyId } }),
      tx.room.count({ where: { propertyId, active: true } }),
      tx.room.count({ where: { propertyId, layoutX: { not: null } } }),
    ]);
    return { state, property, counts: { buildings, floors, types, rooms, placed } };
  });
}

/** Saves the step the user is on so the wizard resumes there. */
export async function saveStep(db: PrismaClient, ctx: Ctx, step: unknown) {
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  const s = z.number().int().min(0).max(LAST).parse(step);
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.onboardingState.upsert({
      where: { propertyId },
      create: { tenantId: ctx.tenantId, propertyId, step: s },
      update: { step: s },
    });
  });
}

/** Marks setup complete. Requires at least one room type and one room. */
export async function completeOnboarding(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [types, rooms] = await Promise.all([tx.roomType.count({ where: { propertyId, active: true } }), tx.room.count({ where: { propertyId, active: true } })]);
    if (types === 0) throw new AppError("VALIDATION", "Add at least one room category before finishing.");
    if (rooms === 0) throw new AppError("VALIDATION", "Add at least one room before finishing.");
    await tx.onboardingState.upsert({
      where: { propertyId },
      create: { tenantId: ctx.tenantId, propertyId, step: LAST, completedAt: new Date() },
      update: { step: LAST, completedAt: new Date() },
    });
    await audit(tx, ctx, { action: "onboarding.complete", entityType: "Property", entityId: propertyId, after: { types, rooms } });
  });
}
