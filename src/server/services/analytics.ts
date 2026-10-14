import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { arr, countedStatuses, dayKind, occupancyPct, revpar, type DayKind } from "@/server/domain/kpi";
import { blockCoversDate } from "@/server/domain/roomBlock";
import { dateInZone } from "@/server/domain/roomStatus";
import { toDate } from "./availability";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(toDate(s).getTime() + n * 86_400_000));
const MAX_DAYS = 62;

export type DayKpi = {
  date: string;
  kind: DayKind;
  sold: number;
  sellable: number;
  unsellable: number;
  occupancyPct: number;
  arrivals: number;
  departures: number;
  /** Room revenue, net of tax. Null when the viewer lacks billing access. */
  postedMinor: number | null;
  estimatedMinor: number | null;
  revenueMinor: number | null;
  arrMinor: number | null;
  revparMinor: number | null;
};

export type Slice = { label: string; sold: number; sellable: number; occupancyPct: number };

export type RangeKpis = {
  from: string;
  to: string;
  today: string;
  days: DayKpi[];
  totals: { sold: number; sellableNights: number; occupancyPct: number; postedMinor: number | null; estimatedMinor: number | null; revenueMinor: number | null; arrMinor: number | null; revparMinor: number | null };
  byFloor: Slice[];
  byCategory: Slice[];
  sources: { source: string; count: number }[];
  /** True when revenue figures are visible to this user. */
  revenueVisible: boolean;
};

const rangeSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), focus: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/**
 * Occupancy, ARR and RevPAR for a date range.
 * - Past nights count guests who stayed; tonight counts guests in house; later nights count valid bookings (a forecast).
 * - Room revenue is net of tax. Nights already posted to a folio use the posted amount; nights not yet posted (room
 *   nights are posted at checkout) use the booked nightly rate, and are reported separately as estimates.
 * - Rooms that are blocked for maintenance or out of order are removed from sellable inventory.
 */
export async function rangeKpis(db: PrismaClient, ctx: Ctx, input: unknown = {}): Promise<RangeKpis> {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const f = rangeSchema.parse(input);
  const revenueVisible = roleHasPermission(ctx.role, "billing.view", ctx.extra);

  return withTenant(db, ctx.tenantId, async (tx) => {
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
    const today = dateInZone(new Date(), prop.timezone);
    const from = f.from ?? today;
    const to = f.to ?? addDays(from, 6);
    if (to < from) return rangeKpis(db, ctx, { from: to, to: from, focus: f.focus });
    const span = Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000) + 1;
    if (span > MAX_DAYS) return rangeKpis(db, ctx, { from, to: addDays(from, MAX_DAYS - 1), focus: f.focus });

    const [rooms, types, blocks, resv, posted] = await Promise.all([
      tx.room.findMany({ where: { propertyId }, select: { id: true, floor: true, roomTypeId: true, outOfOrder: true, floorRef: { select: { label: true, building: { select: { name: true } } } } } }),
      tx.roomType.findMany({ where: { propertyId }, select: { id: true, name: true, baseRateMinor: true } }),
      tx.maintenanceRequest.findMany({ where: { propertyId, blocksRoom: true, status: { not: "RESOLVED" } }, select: { roomId: true, startDate: true, expectedResolution: true } }),
      tx.reservation.findMany({
        where: { propertyId, status: { in: ["CHECKED_IN", "CHECKED_OUT", "CONFIRMED"] }, arrival: { lte: toDate(to) }, departure: { gt: toDate(from) } },
        select: {
          id: true, status: true, arrival: true, departure: true, roomTypeId: true, agreedRateMinor: true, source: true,
          assignments: { orderBy: { createdAt: "desc" }, take: 1, select: { roomId: true } },
        },
      }),
      revenueVisible
        ? tx.folioEntry.findMany({
            where: { propertyId, category: "ROOM", kind: { in: ["CHARGE", "DISCOUNT", "REVERSAL"] }, serviceDate: { gte: toDate(from), lte: toDate(to) } },
            select: { serviceDate: true, netMinor: true, folio: { select: { reservationId: true } } },
          })
        : Promise.resolve([]),
    ]);

    const typeRate = new Map(types.map((t) => [t.id, t.baseRateMinor]));
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const postedBy = new Map<string, number>();
    for (const e of posted) {
      if (!e.serviceDate) continue;
      const k = `${e.folio.reservationId}|${iso(e.serviceDate)}`;
      postedBy.set(k, (postedBy.get(k) ?? 0) + e.netMinor);
    }
    const blockWindows = blocks.map((b) => ({ roomId: b.roomId, w: { startDate: b.startDate ? iso(b.startDate) : null, expectedResolution: b.expectedResolution ? iso(b.expectedResolution) : null } }));
    const unsellableOn = (d: string) => {
      const ids = new Set<string>();
      for (const b of blockWindows) if (blockCoversDate(b.w, d)) ids.add(b.roomId);
      if (d >= today) for (const r of rooms) if (r.outOfOrder) ids.add(r.id);
      return ids;
    };

    const days: DayKpi[] = [];
    const focus = f.focus && f.focus >= from && f.focus <= to ? f.focus : from <= today && today <= to ? today : from;
    const floorAgg = new Map<string, { sold: number; sellable: number }>();
    const catAgg = new Map<string, { sold: number; sellable: number }>();
    let totSold = 0, totSellable = 0, totPosted = 0, totEst = 0;

    for (let i = 0; i < span; i++) {
      const d = addDays(from, i);
      const kind = dayKind(d, today);
      const counted = new Set(countedStatuses(kind));
      const bad = unsellableOn(d);
      const sellable = rooms.length - bad.size;
      let sold = 0, postedSum = 0, estSum = 0, arrivals = 0, departures = 0;
      for (const r of resv) {
        const a = iso(r.arrival), dep = iso(r.departure);
        if (a === d) arrivals++;
        if (dep === d) departures++;
        if (!(a <= d && d < dep) || !counted.has(r.status)) continue;
        sold++;
        const key = `${r.id}|${d}`;
        if (postedBy.has(key)) postedSum += postedBy.get(key)!;
        else estSum += r.agreedRateMinor ?? typeRate.get(r.roomTypeId) ?? 0;
        if (d === focus) {
          const room = r.assignments[0] ? roomById.get(r.assignments[0].roomId) : undefined;
          const fl = room?.floorRef ? `${room.floorRef.building.name} – ${room.floorRef.label}` : room?.floor !== null && room?.floor !== undefined ? `Floor ${room.floor}` : "No floor";
          const fa = floorAgg.get(fl) ?? { sold: 0, sellable: 0 };
          fa.sold++;
          floorAgg.set(fl, fa);
          const cn = typeName.get(r.roomTypeId) ?? "Other";
          const ca = catAgg.get(cn) ?? { sold: 0, sellable: 0 };
          ca.sold++;
          catAgg.set(cn, ca);
        }
      }
      if (d === focus) {
        for (const room of rooms) {
          if (bad.has(room.id)) continue;
          const fl = room.floorRef ? `${room.floorRef.building.name} – ${room.floorRef.label}` : room.floor !== null ? `Floor ${room.floor}` : "No floor";
          const fa = floorAgg.get(fl) ?? { sold: 0, sellable: 0 };
          fa.sellable++;
          floorAgg.set(fl, fa);
          const cn = typeName.get(room.roomTypeId) ?? "Other";
          const ca = catAgg.get(cn) ?? { sold: 0, sellable: 0 };
          ca.sellable++;
          catAgg.set(cn, ca);
        }
      }
      const revenue = postedSum + estSum;
      days.push({
        date: d, kind, sold, sellable, unsellable: bad.size, occupancyPct: occupancyPct(sold, sellable), arrivals, departures,
        postedMinor: revenueVisible ? postedSum : null, estimatedMinor: revenueVisible ? estSum : null, revenueMinor: revenueVisible ? revenue : null,
        arrMinor: revenueVisible ? arr(revenue, sold) : null, revparMinor: revenueVisible ? revpar(revenue, sellable) : null,
      });
      totSold += sold; totSellable += sellable; totPosted += postedSum; totEst += estSum;
    }

    const slices = (m: Map<string, { sold: number; sellable: number }>): Slice[] =>
      [...m.entries()].map(([label, v]) => ({ label, sold: v.sold, sellable: v.sellable, occupancyPct: occupancyPct(v.sold, v.sellable) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

    const srcCount = new Map<string, number>();
    for (const r of resv) {
      const a = iso(r.arrival);
      if (a >= from && a <= to) srcCount.set(r.source, (srcCount.get(r.source) ?? 0) + 1);
    }
    const totalRev = totPosted + totEst;
    return {
      from, to, today, days,
      totals: {
        sold: totSold, sellableNights: totSellable, occupancyPct: occupancyPct(totSold, totSellable),
        postedMinor: revenueVisible ? totPosted : null, estimatedMinor: revenueVisible ? totEst : null, revenueMinor: revenueVisible ? totalRev : null,
        arrMinor: revenueVisible ? arr(totalRev, totSold) : null, revparMinor: revenueVisible ? revpar(totalRev, totSellable) : null,
      },
      byFloor: slices(floorAgg), byCategory: slices(catAgg),
      sources: [...srcCount.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
      revenueVisible,
    };
  });
}
