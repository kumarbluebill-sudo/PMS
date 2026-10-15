import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { maskEmail, maskPhone, phoneKey, phoneQuery } from "@/server/domain/guest";
import { audit } from "./audit";

type Tx = Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const guestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(1000).optional(),
  nationality: z.string().trim().max(60).optional(),
  preferences: z.string().trim().max(500).optional(),
});

/** Other guests of this business that share the phone number or email. Never merged automatically. */
export async function findDuplicateGuests(tx: Tx, tenantId: string, d: { phone?: string | null; email?: string | null }, exceptId?: string) {
  const key = phoneKey(d.phone);
  const email = d.email?.trim().toLowerCase();
  if (!key && !email) return [];
  return tx.guest.findMany({
    where: {
      tenantId, ...(exceptId && { id: { not: exceptId } }),
      OR: [...(key ? [{ phoneKey: key }] : []), ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : [])],
    },
    select: { id: true, name: true, phone: true, email: true },
    take: 5,
  });
}

/**
 * Creates a guest. `allowDuplicate` defaults to true for plain guest entry; the booking form passes false so staff
 * see the existing profile first. Even when allowed, nothing is merged.
 */
export async function createGuest(db: PrismaClient, ctx: Ctx, input: unknown, opts: { allowDuplicate?: boolean } = {}) {
  authorize(ctx, "guests.manage");
  const d = guestSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (opts.allowDuplicate === false) {
      const dup = await findDuplicateGuests(tx, ctx.tenantId, d);
      if (dup.length) throw new AppError("CONFLICT", `A guest with the same mobile number or email already exists: ${dup[0].name}. Open that guest, or confirm that this is a different person.`);
    }
    const g = await tx.guest.create({ data: { ...d, phoneKey: phoneKey(d.phone), tenantId: ctx.tenantId } });
    await audit(tx, ctx, { action: "guest.create", entityType: "Guest", entityId: g.id });
    return g;
  });
}

/** The 50 newest guests, or those matching a name or phone. Kept for pages that list guests; the booking form uses `lookupGuests`. */
export async function searchGuests(db: PrismaClient, ctx: Ctx, q = "") {
  authorize(ctx, "guests.view");
  const canSeeContact = ctx.role !== "AUDITOR";
  const pq = phoneQuery(q);
  const rows = await withTenant(db, ctx.tenantId, (tx) =>
    tx.guest.findMany({
      where: q
        ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, ...(pq ? [pq.kind === "exact" ? { phoneKey: pq.key } : { phoneKey: { contains: pq.digits } }] : [])] }
        : {},
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  );
  return rows.map((g) => (canSeeContact ? g : { ...g, phone: null, email: null, notes: null }));
}

export type GuestMatch = { id: string; name: string; phone: string | null; email: string | null; lastStay: string | null; stays: number; duplicate: boolean };

/**
 * Live guest lookup for the reservation form. Matches the phone in any format, the name, and (for staff allowed to
 * see contact details) the email. Returns a handful of rows with the minimum needed to recognise the person: no
 * identity documents, no notes. `duplicate` is set when another profile shares the same phone, so staff can pick.
 */
export async function lookupGuests(db: PrismaClient, ctx: Ctx, rawQuery: string): Promise<GuestMatch[]> {
  authorize(ctx, "guests.view");
  const propertyId = requireProperty(ctx);
  const q = rawQuery.trim().slice(0, 60);
  if (q.length < 2) return [];
  const canSeeContact = ctx.role !== "AUDITOR";
  const canSearchEmail = roleHasPermission(ctx.role, "guests.viewSensitive", ctx.extra);
  const pq = phoneQuery(q);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const guests = await tx.guest.findMany({
      where: {
        tenantId: ctx.tenantId,
        OR: [
          ...(pq ? [pq.kind === "exact" ? { phoneKey: pq.key } : { phoneKey: { contains: pq.digits } }] : []),
          ...(pq ? [] : [{ name: { contains: q, mode: "insensitive" as const } }]),
          ...(canSearchEmail && q.includes("@") ? [{ email: { contains: q, mode: "insensitive" as const } }] : []),
        ],
      },
      select: { id: true, name: true, phone: true, email: true, phoneKey: true },
      orderBy: [{ updatedAt: "desc" }],
      take: 8,
    });
    if (!guests.length) return [];
    const ids = guests.map((g) => g.id);
    const stays = await tx.reservation.groupBy({
      by: ["guestId"], where: { propertyId, guestId: { in: ids }, status: { in: ["CHECKED_IN", "CHECKED_OUT"] } }, _count: { _all: true }, _max: { arrival: true },
    });
    const keys = [...new Set(guests.map((g) => g.phoneKey).filter((k): k is string => !!k))];
    const shared = keys.length ? await tx.guest.groupBy({ by: ["phoneKey"], where: { tenantId: ctx.tenantId, phoneKey: { in: keys } }, _count: { _all: true } }) : [];
    const dupKeys = new Set(shared.filter((s) => s._count._all > 1).map((s) => s.phoneKey));
    return guests.map((g) => {
      const st = stays.find((s) => s.guestId === g.id);
      return {
        id: g.id, name: g.name, phone: canSeeContact ? g.phone : null, email: canSeeContact ? g.email : null,
        lastStay: st?._max.arrival ? iso(st._max.arrival) : null, stays: st?._count._all ?? 0, duplicate: !!g.phoneKey && dupKeys.has(g.phoneKey),
      };
    });
  });
}

/** A guest's master profile. The ID number is never returned, only whether one is on file. */
export async function getGuestProfile(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "guests.view");
  const canSeeContact = ctx.role !== "AUDITOR";
  return withTenant(db, ctx.tenantId, async (tx) => {
    const g = await tx.guest.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!g) throw new AppError("NOT_FOUND", "Guest not found.");
    const { idNumberEnc, ...rest } = g;
    return { ...rest, ...(canSeeContact ? {} : { phone: null, email: null, notes: null, preferences: null }), idRecorded: !!idNumberEnc };
  });
}

const profileEdit = z.object({
  name: z.string().trim().min(1, "Enter the guest's name.").max(120),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(200).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address.").optional(),
  nationality: z.string().trim().max(60).optional(),
  preferences: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
  address: z.string().trim().max(300).optional(),
  companyName: z.string().trim().max(120).optional(),
  expectedUpdatedAt: z.string().optional(),
});

/**
 * Edits the guest's master profile. This changes the person's record for every booking; it does not rewrite a
 * reservation. The audit entry lists which fields changed, with phone and email masked.
 */
export async function updateGuest(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "guests.manage");
  const d = profileEdit.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.guest.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!cur) throw new AppError("NOT_FOUND", "Guest not found.");
    if (d.expectedUpdatedAt && new Date(d.expectedUpdatedAt).getTime() !== cur.updatedAt.getTime()) {
      throw new AppError("CONFLICT", "Someone else changed this guest while you were editing. Reload the page and try again.");
    }
    const next = {
      name: d.name, phone: d.phone || null, email: d.email || null, nationality: d.nationality || null, preferences: d.preferences || null,
      notes: d.notes || null, address: d.address || null, companyName: d.companyName || null,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (cur[k] ?? null) !== next[k]);
    if (!changed.length) return cur;
    const g = await tx.guest.update({ where: { id }, data: { ...next, phoneKey: phoneKey(next.phone) } });
    await audit(tx, ctx, {
      action: "guest.update", entityType: "Guest", entityId: id,
      before: { fields: changed, name: cur.name, phone: maskPhone(cur.phone), email: maskEmail(cur.email), nationality: cur.nationality },
      after: { fields: changed, name: g.name, phone: maskPhone(g.phone), email: maskEmail(g.email), nationality: g.nationality },
      reason: "Master profile edited; existing reservations are not rewritten.",
    });
    return g;
  });
}

export type GuestHistory = Awaited<ReturnType<typeof guestHistory>>;

/**
 * What staff need to recognise a returning guest at this property: past stays, totals, preferences and, only for
 * staff with billing access, any balance still open on current stays. No identity documents.
 */
export async function guestHistory(db: PrismaClient, ctx: Ctx, guestId: string) {
  authorize(ctx, "guests.view");
  const propertyId = requireProperty(ctx);
  const canSeeContact = ctx.role !== "AUDITOR";
  const canBalance = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const g = await tx.guest.findFirst({ where: { id: guestId, tenantId: ctx.tenantId } });
    if (!g) throw new AppError("NOT_FOUND", "Guest not found.");
    const res = await tx.reservation.findMany({
      where: { guestId, propertyId }, orderBy: { arrival: "desc" }, take: 25,
      include: { assignments: { where: { active: true }, include: { room: { select: { number: true } } } } },
    });
    const types = await tx.roomType.findMany({ where: { id: { in: [...new Set(res.map((r) => r.roomTypeId))] } }, select: { id: true, name: true } });
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    const stayed = res.filter((r) => r.status === "CHECKED_IN" || r.status === "CHECKED_OUT");
    let outstandingMinor: number | null = null;
    if (canBalance) {
      const live = res.filter((r) => ["TENTATIVE", "CONFIRMED", "CHECKED_IN"].includes(r.status)).map((r) => r.id);
      const sums = live.length ? await tx.folioEntry.groupBy({ by: ["folioId"], where: { folio: { reservationId: { in: live } } }, _sum: { balanceDeltaMinor: true } }) : [];
      outstandingMinor = sums.reduce((t, s) => t + Math.max(0, s._sum.balanceDeltaMinor ?? 0), 0);
    }
    return {
      guest: { id: g.id, name: g.name, phone: canSeeContact ? g.phone : null, email: canSeeContact ? g.email : null, nationality: g.nationality, companyName: g.companyName },
      preferences: canSeeContact ? g.preferences : null,
      notes: canSeeContact ? g.notes : null,
      totalStays: stayed.length,
      lastVisit: stayed.length ? iso(stayed[0].arrival) : null,
      outstandingMinor,
      reservations: res.map((r) => ({
        id: r.id, reference: r.reference, status: r.status, arrival: iso(r.arrival), departure: iso(r.departure),
        category: typeName.get(r.roomTypeId) ?? "", room: r.assignments[0]?.room.number ?? null, requests: r.notes,
      })),
    };
  });
}
