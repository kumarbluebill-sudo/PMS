import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { blockOverlapsStay } from "@/server/domain/roomBlock";

export const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export const isOverlapError = (e: unknown) =>
  e instanceof Error &&
  /no_overlap|23P01|exclusion constraint/i.test(e.message + JSON.stringify((e as { meta?: unknown }).meta ?? ""));

export const newReference = (prefix = "MK") => `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;

/**
 * A reference no reservation of this business already uses. It checks before issuing and tries again on a clash; the
 * unique index on (tenantId, reference) remains the final guard if two bookings pick the same one at once.
 */
export async function uniqueReference(tx: Prisma.TransactionClient, tenantId: string, prefix = "MK"): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = newReference(prefix);
    if (!(await tx.reservation.findFirst({ where: { tenantId, reference: ref }, select: { id: true } }))) return ref;
  }
  throw new Error("Could not allocate a unique reservation reference.");
}

export const isReferenceClash = (e: unknown) =>
  e instanceof Error && /reservations_tenantId_reference_key|\(tenantId, reference\)|Unique constraint failed.*reference/i.test(e.message + JSON.stringify((e as { meta?: unknown }).meta ?? ""));

/** Rooms of a type that are sellable and free for [arrival, departure). */
export async function findFreeRooms(
  tx: Prisma.TransactionClient,
  propertyId: string,
  roomTypeId: string,
  arrival: string,
  departure: string,
) {
  // A block removes a room only for the dates it covers; an out-of-order flag with no open block stays excluded.
  const blocking = await tx.maintenanceRequest.findMany({
    where: { propertyId, blocksRoom: true, status: { not: "RESOLVED" } },
    select: { roomId: true, startDate: true, expectedResolution: true },
  });
  const blockedForStay = new Set(
    blocking
      .filter((b) => blockOverlapsStay({ startDate: isoDay(b.startDate), expectedResolution: isoDay(b.expectedResolution) }, arrival, departure))
      .map((b) => b.roomId),
  );
  const hasOpenBlock = new Set(blocking.map((b) => b.roomId));
  const rooms = await tx.room.findMany({
    where: {
      propertyId,
      roomTypeId,
      active: true,
      id: { notIn: [...blockedForStay] },
      assignments: {
        none: { active: true, arrival: { lt: toDate(departure) }, departure: { gt: toDate(arrival) } },
      },
    },
    orderBy: { number: "asc" },
  });
  return rooms.filter((r) => !r.outOfOrder || hasOpenBlock.has(r.id));
}
