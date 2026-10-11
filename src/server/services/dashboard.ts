import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import {
  DISPLAY_STATUSES,
  SELLABLE,
  dateInZone,
  deriveRoomStatus,
  paymentStatusOf,
  type DisplayStatus,
} from "@/server/domain/roomStatus";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const boardFilterSchema = z.object({
  date: day.optional(),
  floor: z.number().int().min(-5).max(200).optional(),
  roomTypeId: z.string().uuid().optional(),
  status: z.enum(DISPLAY_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
  arrival: day.optional(),
  checkout: day.optional(),
  sort: z.enum(["number", "checkout", "status"]).default("number"),
});
export type BoardFilter = z.input<typeof boardFilterSchema>;

export type BoardStay = {
  reservationId: string;
  reference: string;
  guestId: string | null;
  guest: string | null;
  reservationStatus: string;
  arrival: string;
  departure: string;
  /** CURRENT = in house / projected stay, UPCOMING = next booking, LAST = stay that checked out today. */
  kind: "CURRENT" | "UPCOMING" | "LAST";
  actualCheckout: string | null;
};

export type BoardRow = {
  roomId: string;
  number: string;
  floor: number | null;
  roomTypeId: string;
  roomType: string;
  housekeeping: string;
  status: DisplayStatus;
  /** Out-of-order or maintenance reason for the room, when applicable. */
  reason: string | null;
  maintenanceId: string | null;
  stay: BoardStay | null;
  balanceMinor: number | null;
  paymentStatus: string | null;
};

export type BoardCards = {
  totalRooms: number;
  available: number;
  availableReserved: number;
  occupied: number;
  arrivalsToday: number;
  checkoutsToday: number;
  checkedOutToday: number;
  outOfOrder: number;
  maintenance: number;
  cleaning: number;
  expectedRevenueMinor: number;
  /** null when the viewer lacks billing access. */
  pendingPaymentsMinor: number | null;
};

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const STATUS_ORDER = new Map(DISPLAY_STATUSES.map((s, i) => [s, i]));

/**
 * The room board: every room in the property with its derived status and stay. Cards are computed from the
 * same data as the table so the two reconcile. All values come from the database.
 */
export async function roomBoard(db: PrismaClient, ctx: Ctx, input: BoardFilter = {}) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const f = boardFilterSchema.parse(input);
  const canGuests = roleHasPermission(ctx.role, "reservations.view", ctx.extra);
  const canBilling = roleHasPermission(ctx.role, "billing.view", ctx.extra);

  return withTenant(db, ctx.tenantId, async (tx) => {
    const property = await tx.property.findFirstOrThrow({
      where: { id: propertyId },
      select: { timezone: true, checkOutTime: true },
    });
    const today = dateInZone(new Date(), property.timezone);
    const date = f.date ?? today;
    const live = date === today;

    const allRooms = await tx.room.findMany({ where: { propertyId }, include: { roomType: true } });
    const floors = [...new Set(allRooms.map((r) => r.floor).filter((x): x is number => x !== null))].sort((a, b) => a - b);
    const roomTypes = [...new Map(allRooms.map((r) => [r.roomTypeId, r.roomType.name])).entries()].map(([id, name]) => ({ id, name }));
    const scope = allRooms
      .filter((r) => (f.floor === undefined || r.floor === f.floor) && (!f.roomTypeId || r.roomTypeId === f.roomTypeId))
      .sort((a, b) => natural(a.number, b.number));
    const scopeIds = new Set(scope.map((r) => r.id));

    const assignments = await tx.roomAssignment.findMany({
      where: {
        propertyId,
        active: true,
        reservation: { status: { in: ["CHECKED_IN", "CONFIRMED"] } },
        OR: [{ departure: { gte: toDate(date) } }, { reservation: { status: "CHECKED_IN" } }],
      },
      include: { reservation: { select: { id: true, reference: true, status: true, arrival: true, departure: true, guestId: true, roomTypeId: true, guest: { select: { name: true } } } } },
    });

    const open = await tx.maintenanceRequest.findMany({
      where: { propertyId, status: { not: "RESOLVED" } },
      orderBy: { createdAt: "desc" },
      select: { id: true, roomId: true, title: true, blocksRoom: true },
    });

    // Reservations that checked out on the viewed date (their assignment is inactive after checkout).
    const outs = await tx.reservationStatusHistory.findMany({
      where: { toStatus: "CHECKED_OUT", changedAt: { gte: new Date(Date.now() - 4 * 86_400_000) }, reservation: { propertyId } },
      select: { reservationId: true, changedAt: true },
    });
    const outToday = outs.filter((o) => dateInZone(o.changedAt, property.timezone) === date);
    const outAssignments = outToday.length
      ? await tx.roomAssignment.findMany({
          where: { reservationId: { in: outToday.map((o) => o.reservationId) } },
          orderBy: { createdAt: "desc" },
          include: { reservation: { select: { id: true, reference: true, status: true, arrival: true, departure: true, guestId: true, roomTypeId: true, guest: { select: { name: true } } } } },
        })
      : [];

    type Res = (typeof assignments)[number]["reservation"];
    const mk = (r: Res, kind: BoardStay["kind"], actualCheckout: Date | null): BoardStay => ({
      reservationId: r.id,
      reference: r.reference,
      guestId: canGuests ? r.guestId : null,
      guest: canGuests ? r.guest.name : null,
      reservationStatus: r.status,
      arrival: iso(r.arrival),
      departure: iso(r.departure),
      kind,
      actualCheckout: actualCheckout ? actualCheckout.toISOString() : null,
    });

    const byRoom = <T extends { roomId: string }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(x.roomId, [...(m.get(x.roomId) ?? []), x]);
      return m;
    };
    const aByRoom = byRoom(assignments);
    const oByRoom = byRoom(open);
    const lastOut = new Map<string, (typeof outAssignments)[number]>();
    for (const a of outAssignments) if (!lastOut.has(a.reservationId)) lastOut.set(a.reservationId, a);
    const outByRoom = byRoom([...lastOut.values()]);
    const outTime = new Map(outToday.map((o) => [o.reservationId, o.changedAt]));

    const rows: BoardRow[] = scope.map((room) => {
      const list = (aByRoom.get(room.id) ?? []).slice().sort((a, b) => +a.arrival - +b.arrival);
      const inHouse = list.find((a) => a.reservation.status === "CHECKED_IN");
      const projected = list.find((a) => iso(a.arrival) < date && iso(a.departure) >= date);
      const upcomingA = list.find((a) => a.reservation.status === "CONFIRMED" && iso(a.arrival) >= date);
      const requests = oByRoom.get(room.id) ?? [];
      const blocking = requests.find((m) => m.blocksRoom);
      const status = deriveRoomStatus({
        outOfOrder: room.outOfOrder,
        maintenanceBlock: !!blocking,
        housekeeping: room.housekeeping,
        inHouse: inHouse ? { departure: iso(inHouse.departure) } : null,
        expectedStay: projected ? { arrival: iso(projected.arrival), departure: iso(projected.departure) } : null,
        upcoming: upcomingA ? { arrival: iso(upcomingA.arrival) } : null,
        date,
        live,
      });

      // A current stay wins; a reserved room shows its next booking; otherwise the stay that checked out on the viewed date.
      const current = live ? inHouse : projected;
      const o = (outByRoom.get(room.id) ?? [])[0];
      const stay: BoardStay | null = current
        ? mk(current.reservation, "CURRENT", null)
        : status === "RESERVED" && upcomingA
          ? mk(upcomingA.reservation, "UPCOMING", null)
          : o
            ? mk(o.reservation, "LAST", outTime.get(o.reservationId) ?? null)
            : upcomingA
              ? mk(upcomingA.reservation, "UPCOMING", null)
              : null;

      const reason =
        status === "OUT_OF_ORDER" ? (requests.find((m) => m.blocksRoom)?.title ?? "No reason recorded") :
        status === "MAINTENANCE" ? (blocking?.title ?? null) : null;
      return {
        roomId: room.id,
        number: room.number,
        floor: room.floor,
        roomTypeId: room.roomTypeId,
        roomType: room.roomType.name,
        housekeeping: room.housekeeping,
        status,
        reason,
        maintenanceId: (blocking ?? requests[0])?.id ?? null,
        stay,
        balanceMinor: null,
        paymentStatus: null,
      };
    });

    // Folio balances for the stays shown, plus every in-house folio for the pending-payments card.
    let pending: number | null = null;
    if (canBilling) {
      const inHouseRes = assignments.filter((a) => a.reservation.status === "CHECKED_IN" && scopeIds.has(a.roomId)).map((a) => a.reservationId);
      const shown = rows.map((r) => r.stay?.reservationId).filter((x): x is string => !!x);
      const folios = await tx.folio.findMany({ where: { propertyId, reservationId: { in: [...new Set([...inHouseRes, ...shown])] } }, select: { id: true, reservationId: true } });
      const sums = await tx.folioEntry.groupBy({ by: ["folioId", "kind"], where: { folioId: { in: folios.map((x) => x.id) } }, _sum: { balanceDeltaMinor: true } });
      const fByRes = new Map(folios.map((x) => [x.reservationId, x.id]));
      const figures = (folioId: string) => {
        const s = (k: string[]) => sums.filter((x) => x.folioId === folioId && k.includes(x.kind)).reduce((t, x) => t + (x._sum.balanceDeltaMinor ?? 0), 0);
        const billed = s(["CHARGE", "DISCOUNT", "REVERSAL"]);
        const paid = -s(["PAYMENT"]);
        const refunded = s(["REFUND"]);
        const balance = billed - paid + refunded;
        return { balance, status: paymentStatusOf(billed, paid, refunded, balance) };
      };
      for (const r of rows) {
        const fid = r.stay ? fByRes.get(r.stay.reservationId) : undefined;
        if (fid) {
          const x = figures(fid);
          r.balanceMinor = x.balance;
          r.paymentStatus = x.status;
        }
      }
      pending = inHouseRes.reduce((t, id) => {
        const fid = fByRes.get(id);
        return t + (fid ? Math.max(0, figures(fid).balance) : 0);
      }, 0);
    }

    // Expected room revenue for the night of `date`: in-house guests not leaving, plus arrivals, at base rate.
    const rateOf = new Map(allRooms.map((r) => [r.roomTypeId, r.roomType.baseRateMinor]));
    const nightly = assignments.filter(
      (a) => scopeIds.has(a.roomId) &&
        ((a.reservation.status === "CHECKED_IN" && iso(a.departure) > date) || (a.reservation.status === "CONFIRMED" && iso(a.arrival) === date)),
    );
    const count = (s: DisplayStatus) => rows.filter((r) => r.status === s).length;
    const cards: BoardCards = {
      totalRooms: rows.length,
      available: rows.filter((r) => SELLABLE.has(r.status)).length,
      availableReserved: count("RESERVED"),
      occupied: count("OCCUPIED") + count("DUE_OUT"),
      arrivalsToday: assignments.filter((a) => scopeIds.has(a.roomId) && a.reservation.status === "CONFIRMED" && iso(a.arrival) === date).length,
      checkoutsToday: count("DUE_OUT"),
      checkedOutToday: new Set(outAssignments.filter((a) => scopeIds.has(a.roomId)).map((a) => a.reservationId)).size,
      outOfOrder: count("OUT_OF_ORDER"),
      maintenance: count("MAINTENANCE"),
      cleaning: count("CLEANING"),
      expectedRevenueMinor: nightly.reduce((t, a) => t + (rateOf.get(a.reservation.roomTypeId) ?? 0), 0),
      pendingPaymentsMinor: pending,
    };

    const q = f.q?.toLowerCase();
    let view = rows.filter((r) => {
      if (f.status && r.status !== f.status) return false;
      if (f.arrival && r.stay?.arrival !== f.arrival) return false;
      if (f.checkout && r.stay?.departure !== f.checkout) return false;
      if (q && !(r.number.toLowerCase().includes(q) || r.stay?.guest?.toLowerCase().includes(q) || r.stay?.reference.toLowerCase().includes(q))) return false;
      return true;
    });
    if (f.sort === "checkout") {
      view = view.slice().sort((a, b) => (a.stay?.departure ?? "9999").localeCompare(b.stay?.departure ?? "9999") || natural(a.number, b.number));
    } else if (f.sort === "status") {
      view = view.slice().sort((a, b) => (STATUS_ORDER.get(a.status)! - STATUS_ORDER.get(b.status)!) || natural(a.number, b.number));
    }
    return { date, today, live, checkOutTime: property.checkOutTime, floors, roomTypes, cards, rows: view, allRowCount: rows.length };
  });
}
