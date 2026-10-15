import { z } from "zod";
import type { Prisma, PrismaClient, Reservation } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError, toSafeError } from "@/server/errors";
import { encryptSecret } from "@/server/crypto";
import { calculateTax, TaxEngineError } from "@/server/domain/gst";
import { extraPersonPerNight } from "@/server/domain/folio";
import { effectiveExtras, effectiveNightRates, type RateSnapshot } from "@/server/domain/rates";
import { BOOKING_SOURCES, LEGACY_SOURCES, discountedRate, normalizeMobile } from "@/server/domain/quote";
import { nightsBetween, stayNights } from "@/server/domain/stay";
import { dateInZone } from "@/server/domain/roomStatus";
import { audit } from "./audit";
import { findFreeRooms, isOverlapError, isReferenceClash, toDate, uniqueReference } from "./availability";
import { ensureFolio, loadRules } from "./billing";
import { recordPayment } from "./payments";
import { phoneKey } from "@/server/domain/guest";
import { findDuplicateGuests } from "./guests";
import { loadPlans } from "./property";
import { loadSettings } from "./settings";
import { randomBytes } from "node:crypto";

type Tx = Prisma.TransactionClient;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
const money = z.number().int().min(0).max(1_000_000_000);

const quoteFields = {
  roomTypeId: z.string().uuid(),
  arrival: day,
  departure: day,
  rooms: z.number().int().min(1).max(20).default(1),
  adults: z.number().int().min(1).max(100).default(1),
  children: z.number().int().min(0).max(100).default(0),
  discountPercentBp: z.number().int().min(0).max(10_000).optional(),
  discountAmountMinor: money.optional(),
  /** A specific rate plan the guest chose; without it the best applicable plan is used. */
  ratePlanId: z.string().uuid().optional(),
};
export const quoteSchema = z.object(quoteFields);
export type QuoteInput = z.input<typeof quoteSchema>;

export type Quote = {
  available: number;
  rooms: number;
  nights: number;
  baseRateMinor: number;
  rateMinor: number;
  discountPerNightMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxStatus: "NOT_REGISTERED" | "APPLIED" | "UNCONFIGURED";
  taxNote: string | null;
  /** Deposit the hotel asks for, from its reservation settings (0 when none). */
  depositRequiredMinor: number;
  roomType: string;
  nightly: { date: string; netMinor: number; taxMinor: number; grossMinor: number; rateMinor: number; planName: string | null }[];
  /** The plan that set the rate (the first one when it changes during the stay). */
  ratePlan: { id: string; name: string } | null;
  rateVaries: boolean;
  /** Extra-person charges included in the subtotal, before tax. */
  extraPersonMinor: number;
  /** Frozen onto each reservation when the booking is saved. */
  snapshot: RateSnapshot;
};

function nightsOrThrow(arrival: string, departure: string) {
  try {
    return nightsBetween(arrival, departure);
  } catch (e) {
    throw new AppError("VALIDATION", e instanceof Error && /after arrival/.test(e.message) ? "Check-out must be after check-in." : "Enter valid dates.");
  }
}

/** Splits a guest count across rooms the way the booking spreads them (earlier rooms take the remainder). */
const shareOf = (total: number, rooms: number, i: number) => Math.floor(total / rooms) + (i < total % rooms ? 1 : 0);

/** Availability, nightly rates, discount and GST for a stay. Runs inside the caller's transaction; the browser's numbers are never used. */
export async function computeQuote(tx: Tx, ctx: Ctx, propertyId: string, input: z.output<typeof quoteSchema>): Promise<Quote> {
  const nights = nightsOrThrow(input.arrival, input.departure);
  if (nights > 365) throw new AppError("VALIDATION", "A stay cannot be longer than 365 nights.");
  const st = await loadSettings(tx, ctx.tenantId, propertyId);
  if (nights < st["reservation.minNights"]) throw new AppError("VALIDATION", `The minimum stay is ${st["reservation.minNights"]} night(s).`);
  if (nights > st["reservation.maxNights"]) throw new AppError("VALIDATION", `The maximum stay is ${st["reservation.maxNights"]} night(s).`);
  const [rt, property, rules, plans] = await Promise.all([
    tx.roomType.findFirst({ where: { id: input.roomTypeId, propertyId } }),
    tx.property.findFirstOrThrow({ where: { id: propertyId } }),
    loadRules(tx, ctx.tenantId),
    loadPlans(tx, propertyId),
  ]);
  if (!rt) throw new AppError("NOT_FOUND", "Room type not found.");
  if (!rt.active) throw new AppError("VALIDATION", `"${rt.name}" is not open for new bookings.`);
  if (input.ratePlanId) {
    const chosen = plans.find((p) => p.id === input.ratePlanId);
    if (!chosen || !chosen.active || !chosen.rates.some((r) => r.roomTypeId === rt.id)) throw new AppError("VALIDATION", "That rate plan is not available for this category.");
  }

  const dates = stayNights(input.arrival, input.departure);
  const base = effectiveNightRates({
    roomTypeId: rt.id, baseRateMinor: rt.baseRateMinor, dates, adults: Math.ceil(input.adults / input.rooms), children: Math.ceil(input.children / input.rooms),
    plans, onlyPlanId: input.ratePlanId ?? null,
  });
  const extras = effectiveExtras(base, plans, rt.id, rt);
  // Each night is discounted on its own rate, and the cap applies to every night.
  const discount = { percentBp: input.discountPercentBp, amountMinor: input.discountAmountMinor };
  const rated = base.map((n) => {
    let rate: number;
    try {
      rate = discountedRate(n.rateMinor, discount);
    } catch (e) {
      throw new AppError("VALIDATION", e instanceof Error ? e.message : "Invalid discount.");
    }
    const pct = n.rateMinor > 0 ? ((n.rateMinor - rate) * 100) / n.rateMinor : 0;
    if (pct > st["billing.maxDiscountPercent"] + 1e-9) throw new AppError("VALIDATION", `Discounts are limited to ${st["billing.maxDiscountPercent"]}% at this property.`);
    return { ...n, base: n.rateMinor, rate };
  });
  const free = await findFreeRooms(tx, propertyId, rt.id, input.arrival, input.departure);

  let taxStatus: Quote["taxStatus"] = property.gstRegistered ? "APPLIED" : "NOT_REGISTERED";
  let taxNote: string | null = property.gstRegistered ? null : "This property is not GST registered: a Bill of Supply is issued and no GST is charged.";
  const supplier = { supplierRegistered: property.gstRegistered, supplierStateCode: property.gstStateCode, recipientStateCode: null };
  const taxOf = (amountMinor: number, date: string, tariff: number) => {
    try {
      return calculateTax({ amountMinor, taxInclusive: false, category: "ROOM", serviceDate: date, unitTariffMinor: tariff }, supplier, rules);
    } catch (e) {
      if (!(e instanceof TaxEngineError)) throw e;
      taxStatus = "UNCONFIGURED";
      taxNote = `GST could not be estimated: ${e.message}`;
      return { netMinor: amountMinor, taxMinor: 0, grossMinor: amountMinor };
    }
  };
  // Extra-person charges are priced per room from how guests are spread, and taxed on the whole nightly tariff.
  const extraPerRoom = Array.from({ length: input.rooms }, (_, i) =>
    extraPersonPerNight({ adults: Math.max(1, shareOf(input.adults, input.rooms, i)), children: shareOf(input.children, input.rooms, i), baseOccupancy: rt.baseOccupancy, ...extras }),
  );
  const nightly: Quote["nightly"] = [];
  let extraTotal = 0;
  for (const n of rated) {
    let netMinor = 0, taxMinor = 0, grossMinor = 0;
    for (const extra of extraPerRoom) {
      const room = taxOf(n.rate, n.date, n.rate + extra);
      netMinor += room.netMinor; taxMinor += room.taxMinor; grossMinor += room.grossMinor;
      if (extra > 0) {
        const x = taxOf(extra, n.date, n.rate + extra);
        netMinor += x.netMinor; taxMinor += x.taxMinor; grossMinor += x.grossMinor;
        extraTotal += x.netMinor;
      }
    }
    nightly.push({ date: n.date, netMinor, taxMinor, grossMinor, rateMinor: n.rate, planName: n.planName });
  }
  const sum = (k: "netMinor" | "taxMinor" | "grossMinor") => nightly.reduce((t, n) => t + n[k], 0);
  const first = rated[0];
  const plan = base.find((n) => n.planId);
  return {
    available: free.length,
    rooms: input.rooms,
    nights,
    baseRateMinor: first.base,
    rateMinor: first.rate,
    discountPerNightMinor: first.base - first.rate,
    subtotalMinor: sum("netMinor"),
    taxMinor: sum("taxMinor"),
    totalMinor: sum("grossMinor"),
    taxStatus,
    taxNote,
    depositRequiredMinor: Math.floor((sum("grossMinor") * st["reservation.depositPercent"] + 50) / 100),
    roomType: rt.name,
    nightly,
    ratePlan: plan ? { id: plan.planId!, name: plan.planName! } : null,
    rateVaries: new Set(rated.map((n) => n.rate)).size > 1,
    extraPersonMinor: extraTotal,
    snapshot: {
      nightly: Object.fromEntries(rated.map((n) => [n.date, n.rate])),
      extraAdultMinor: extras.extraAdultRateMinor, extraChildMinor: extras.extraChildRateMinor, baseOccupancy: rt.baseOccupancy,
    },
  };
}

/** Preview for the booking form. Read-only; the same computation is repeated when the booking is saved. */
export async function quoteStay(db: PrismaClient, ctx: Ctx, input: unknown): Promise<Quote> {
  authorize(ctx, "reservations.create");
  const propertyId = requireProperty(ctx);
  const d = quoteSchema.parse(input);
  return withTenant(db, ctx.tenantId, (tx) => computeQuote(tx, ctx, propertyId, d));
}

/** Free rooms and base rate per room type for a date range (the availability panel on the booking form). */
export async function availabilityByType(db: PrismaClient, ctx: Ctx, arrival: string, departure: string) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  nightsOrThrow(arrival, departure);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const types = await tx.roomType.findMany({ where: { propertyId, active: true }, orderBy: { name: "asc" }, include: { _count: { select: { rooms: { where: { active: true } } } } } });
    return Promise.all(
      types.map(async (t) => ({
        id: t.id, name: t.name, totalRooms: t._count.rooms, baseRateMinor: t.baseRateMinor,
        available: (await findFreeRooms(tx, propertyId, t.id, arrival, departure)).length,
      })),
    );
  });
}

export const ID_TYPES = ["AADHAAR", "PASSPORT", "DRIVING_LICENCE", "VOTER_ID", "PAN", "OTHER"] as const;

const newGuestSchema = z.object({
  name: z.string().trim().min(1, "Enter the guest's name.").max(120),
  mobile: z.string().trim().min(1, "Enter a mobile number."),
  email: z.string().trim().email("Enter a valid email.").optional().or(z.literal("").transform(() => undefined)),
  address: z.string().trim().max(300).optional(),
  idType: z.enum(ID_TYPES).optional(),
  idNumber: z.string().trim().max(40).optional(),
  nationality: z.string().trim().max(60).optional(),
  preferences: z.string().trim().max(500).optional(),
  /** Staff confirmed this is a different person from the guest with the same phone or email. */
  allowDuplicate: z.boolean().optional(),
});

const bookingSchema = z
  .object({
    guestId: z.string().uuid().optional(),
    newGuest: newGuestSchema.optional(),
    /** A specific room, when the booking starts from the room board (single-room bookings only). */
    roomId: z.string().uuid().optional(),
    /** Mobile for an existing guest that has none on file. */
    mobile: z.string().trim().optional(),
    ...quoteFields,
    source: z.enum([...BOOKING_SOURCES, ...LEGACY_SOURCES]).default("WALK_IN"),
    companyName: z.string().trim().max(120).optional(),
    agentName: z.string().trim().max(120).optional(),
    externalRef: z.string().trim().max(60).optional(),
    notes: z.string().trim().max(1000).optional(),
    ratePlan: z.literal("STANDARD").default("STANDARD"),
    discountReason: z.string().trim().max(200).optional(),
    status: z.enum(["CONFIRMED", "TENTATIVE"]).default("CONFIRMED"),
    advance: z
      .object({
        amountMinor: money.min(1, "Enter the advance amount."),
        method: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]),
        reference: z.string().trim().max(100).optional(),
      })
      .optional(),
  })
  .refine((d) => !!d.guestId !== !!d.newGuest, { message: "Choose an existing guest or enter a new one." });
export type BookingInput = z.input<typeof bookingSchema>;

export type BookingResult = {
  reservations: (Reservation & { roomId: string; roomNumber: string })[];
  groupRef: string | null;
  quote: Quote;
  advance: { recorded: boolean; amountMinor: number; error?: string };
  deposit: { requiredMinor: number; met: boolean };
};

/**
 * Creates a booking for one or more rooms of a type. The rooms of that type are locked for the transaction so
 * concurrent bookings serialise; the database exclusion constraint remains the final guard against double booking.
 * Rates, availability, occupancy, discount permission and GST are all recomputed here.
 */
export async function createBooking(
  db: PrismaClient,
  ctx: Ctx,
  input: unknown,
  opts: { allowPast?: boolean; requireMobile?: boolean } = {},
): Promise<BookingResult> {
  authorize(ctx, "reservations.create");
  const propertyId = requireProperty(ctx);
  const parsed = bookingSchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Some fields are invalid.");
  const d = parsed.data;
  const discounted = (d.discountPercentBp ?? 0) > 0 || (d.discountAmountMinor ?? 0) > 0;
  if (discounted) {
    authorize(ctx, "billing.discount");
    if ((d.discountReason?.length ?? 0) < 3) throw new AppError("VALIDATION", "Give a reason for the discount.");
  }
  if (d.newGuest) authorize(ctx, "guests.manage");
  if (d.advance) authorize(ctx, "payments.record");
  const mobileIn = d.newGuest?.mobile ?? d.mobile;
  const mobile = mobileIn ? normalizeMobile(mobileIn) : null;
  if (mobileIn && !mobile) throw new AppError("VALIDATION", "Enter a valid mobile number (7 to 15 digits).");

  let result: Omit<BookingResult, "advance" | "deposit">;
  try {
    result = await withTenant(db, ctx.tenantId, async (tx) => {
      const property = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
      if (!opts.allowPast && d.arrival < dateInZone(new Date(), property.timezone)) {
        throw new AppError("VALIDATION", "Check-in cannot be in the past.");
      }
      nightsOrThrow(d.arrival, d.departure);
      const st = await loadSettings(tx, ctx.tenantId, propertyId);
      if ((BOOKING_SOURCES as readonly string[]).includes(d.source) && !(st["reservation.enabledSources"] as readonly string[]).includes(d.source)) {
        throw new AppError("VALIDATION", `The booking source "${d.source.replaceAll("_", " ").toLowerCase()}" is not in use at this property.`);
      }
      await tx.$queryRaw`SELECT id FROM rooms WHERE "propertyId" = ${propertyId}::uuid AND "roomTypeId" = ${d.roomTypeId}::uuid ORDER BY number FOR UPDATE`;
      const quote = await computeQuote(tx, ctx, propertyId, d);
      const rt = await tx.roomType.findFirstOrThrow({ where: { id: d.roomTypeId, propertyId } });
      if (d.adults > rt.maxAdults * d.rooms || d.children > rt.maxChildren * d.rooms) {
        throw new AppError("VALIDATION", "Guest count exceeds the occupancy of the selected rooms.");
      }
      if (quote.available < 1) {
        throw new AppError("CONFLICT", "No room of this type is available for those dates. Try other dates or another room type.");
      }
      if (quote.available < d.rooms) {
        throw new AppError("CONFLICT", `Only ${quote.available} room(s) of this type are available for those dates; you asked for ${d.rooms}.`);
      }
      if (d.advance && d.advance.amountMinor > quote.totalMinor) {
        throw new AppError("VALIDATION", "The advance cannot exceed the estimated total.");
      }

      let guestId = d.guestId;
      if (d.newGuest) {
        if (!d.newGuest.allowDuplicate) {
          const dup = await findDuplicateGuests(tx, ctx.tenantId, { phone: mobileIn, email: d.newGuest.email });
          if (dup.length) throw new AppError("CONFLICT", `A guest with the same mobile number or email already exists: ${dup[0].name}. Select that guest, or confirm that this is a different person.`);
        }
        const g = await tx.guest.create({
          data: {
            tenantId: ctx.tenantId, name: d.newGuest.name, phone: mobileIn?.trim(), phoneKey: phoneKey(mobileIn), email: d.newGuest.email, address: d.newGuest.address,
            nationality: d.newGuest.nationality, preferences: d.newGuest.preferences,
            idType: d.newGuest.idNumber ? d.newGuest.idType ?? "OTHER" : d.newGuest.idType,
            idNumberEnc: d.newGuest.idNumber ? encryptSecret(d.newGuest.idNumber) : undefined,
            companyName: d.companyName,
          },
        });
        guestId = g.id;
        await audit(tx, ctx, { action: "guest.create", entityType: "Guest", entityId: g.id });
      } else {
        const g = await tx.guest.findFirst({ where: { id: d.guestId! } });
        if (!g) throw new AppError("NOT_FOUND", "Guest not found.");
        if (!g.phone && (mobile || opts.requireMobile !== false)) {
          if (!mobile) throw new AppError("VALIDATION", "This guest has no mobile number on file. Enter one.");
          await tx.guest.update({ where: { id: g.id }, data: { phone: mobileIn?.trim(), phoneKey: phoneKey(mobileIn) } });
        }
      }

      let free = await findFreeRooms(tx, propertyId, d.roomTypeId, d.arrival, d.departure);
      if (d.roomId) {
        const wanted = free.find((r) => r.id === d.roomId);
        if (!wanted) throw new AppError("CONFLICT", "That room is not available for those dates. Choose another room or leave the room unselected.");
        free = [wanted, ...free.filter((r) => r.id !== wanted.id)];
      }
      free = free.slice(0, d.rooms);
      const groupRef = d.rooms > 1 ? `MK-G${randomBytes(3).toString("hex").toUpperCase()}` : null;
      const perRoomTotal = Math.round(quote.totalMinor / d.rooms);
      const reservations: BookingResult["reservations"] = [];
      for (const [i, room] of free.entries()) {
        // Spread guests evenly; every room has at least one adult.
        const share = (total: number) => Math.floor(total / d.rooms) + (i < total % d.rooms ? 1 : 0);
        const adults = Math.max(1, share(d.adults));
        const children = share(d.children);
        const r = await tx.reservation.create({
          data: {
            tenantId: ctx.tenantId, propertyId, reference: await uniqueReference(tx, ctx.tenantId, st["reservation.referencePrefix"]), guestId: guestId!, roomTypeId: d.roomTypeId,
            source: d.source, arrival: toDate(d.arrival), departure: toDate(d.departure), adults, children,
            notes: d.notes, status: d.status, createdBy: ctx.userId, groupRef, companyName: d.companyName, agentName: d.agentName, externalRef: d.externalRef || null,
            ratePlan: quote.ratePlan?.name ?? d.ratePlan, ratePlanId: quote.ratePlan?.id ?? null, agreedRateMinor: quote.rateMinor, rateSnapshot: quote.snapshot as unknown as Prisma.InputJsonValue,
            discountReason: discounted ? d.discountReason : null, quotedTotalMinor: perRoomTotal,
          },
        });
        await tx.roomAssignment.create({
          data: { tenantId: ctx.tenantId, propertyId, roomId: room.id, reservationId: r.id, arrival: r.arrival, departure: r.departure },
        });
        await tx.reservationStatusHistory.create({ data: { tenantId: ctx.tenantId, reservationId: r.id, toStatus: d.status, changedBy: ctx.userId } });
        await audit(tx, ctx, {
          action: "reservation.create", entityType: "Reservation", entityId: r.id,
          after: {
            reference: r.reference, roomId: room.id, arrival: d.arrival, departure: d.departure, source: d.source, groupRef,
            rateMinor: quote.rateMinor, baseRateMinor: quote.baseRateMinor, quotedTotalMinor: perRoomTotal,
          },
          reason: discounted ? d.discountReason : undefined,
        });
        reservations.push({ ...r, roomId: room.id, roomNumber: room.number });
      }
      return { reservations, groupRef, quote };
    });
  } catch (e) {
    if (isOverlapError(e)) throw new AppError("CONFLICT", "A room was just taken by another booking. Please try again.");
    if (isReferenceClash(e)) throw new AppError("CONFLICT", "The booking could not be numbered. Please try again.");
    throw e;
  }

  // The advance is recorded after the booking is safely stored; a failure here never loses the booking.
  const advance: BookingResult["advance"] = { recorded: false, amountMinor: d.advance?.amountMinor ?? 0 };
  if (d.advance) {
    try {
      const first = result.reservations[0];
      const folio = await withTenant(db, ctx.tenantId, (tx) => ensureFolio(tx, ctx, first.id));
      await recordPayment(db, ctx, folio.id, {
        method: d.advance.method, amountMinor: d.advance.amountMinor, reference: d.advance.reference, idempotencyKey: `advance:${first.id}`,
      });
      advance.recorded = true;
    } catch (e) {
      advance.error = toSafeError(e).message;
    }
  }
  const requiredMinor = result.quote.depositRequiredMinor;
  return { ...result, advance, deposit: { requiredMinor, met: requiredMinor === 0 || (advance.recorded && advance.amountMinor >= requiredMinor) } };
}

/** Single-room booking with an existing guest (kept for callers that do not need the full form). */
export async function createReservation(db: PrismaClient, ctx: Ctx, input: unknown) {
  const r = await createBooking(db, ctx, { rooms: 1, ...(input as object) }, { allowPast: true, requireMobile: false });
  return r.reservations[0];
}

/** Everything the printable confirmation needs, for one reservation or the whole multi-room group. */
export async function bookingConfirmation(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const first = await tx.reservation.findFirst({ where: { id, propertyId } });
    if (!first) throw new AppError("NOT_FOUND", "Reservation not found.");
    const group = await tx.reservation.findMany({
      where: first.groupRef ? { tenantId: ctx.tenantId, groupRef: first.groupRef, propertyId } : { id },
      include: { guest: true, assignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: { include: { roomType: true } } } } },
      orderBy: { reference: "asc" },
    });
    const property = await tx.property.findFirstOrThrow({ where: { id: propertyId } });
    let paidMinor: number | null = null;
    if (canMoney) {
      const a = await tx.folioEntry.aggregate({
        where: { kind: "PAYMENT", folio: { reservationId: { in: group.map((g) => g.id) } } },
        _sum: { balanceDeltaMinor: true },
      });
      paidMinor = -(a._sum.balanceDeltaMinor ?? 0);
    }
    const totalMinor = group.reduce((t, g) => t + (g.quotedTotalMinor ?? 0), 0);
    return { property, group, totalMinor, paidMinor, balanceMinor: paidMinor === null ? null : totalMinor - paidMinor };
  });
}
