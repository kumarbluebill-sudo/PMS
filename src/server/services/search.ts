import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";

export type SearchHit = { kind: "GUEST" | "RESERVATION" | "ROOM"; title: string; detail: string; href: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One search box for the whole app. Each group is returned only if the viewer holds the permission for it, so a
 * housekeeper searching for a name gets rooms but never guest records.
 */
export async function globalSearch(db: PrismaClient, ctx: Ctx, rawQuery: string): Promise<SearchHit[]> {
  const q = z.string().trim().min(2).max(60).safeParse(rawQuery);
  if (!q.success) return [];
  const term = q.data;
  const propertyId = requireProperty(ctx);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const hits: SearchHit[] = [];

  await withTenant(db, ctx.tenantId, async (tx) => {
    if (can("rooms.view")) {
      const rooms = await tx.room.findMany({ where: { propertyId, number: { contains: term, mode: "insensitive" } }, include: { roomType: { select: { name: true } } }, take: 8, orderBy: { number: "asc" } });
      for (const r of rooms) hits.push({ kind: "ROOM", title: `Room ${r.number}`, detail: r.roomType.name, href: `/app/dashboard?q=${encodeURIComponent(r.number)}` });
    }
    if (can("reservations.view")) {
      const res = await tx.reservation.findMany({
        where: { propertyId, OR: [{ reference: { contains: term, mode: "insensitive" } }, { guest: { name: { contains: term, mode: "insensitive" } } }] },
        include: { guest: { select: { name: true } } }, orderBy: { arrival: "desc" }, take: 10,
      });
      for (const r of res) hits.push({ kind: "RESERVATION", title: `${r.reference} · ${r.guest.name}`, detail: `${iso(r.arrival)} to ${iso(r.departure)} · ${r.status.replaceAll("_", " ").toLowerCase()}`, href: `/app/reservations/${r.id}` });
    }
    if (can("guests.view")) {
      const guests = await tx.guest.findMany({
        where: { OR: [{ name: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }, ...(can("guests.viewSensitive") ? [{ email: { contains: term, mode: "insensitive" as const } }] : [])] },
        take: 8, orderBy: { name: "asc" },
      });
      for (const g of guests) hits.push({ kind: "GUEST", title: g.name, detail: can("guests.viewSensitive") ? (g.phone ?? g.email ?? "Guest") : "Guest", href: `/app/guests?q=${encodeURIComponent(g.name)}` });
    }
  });
  return hits;
}
