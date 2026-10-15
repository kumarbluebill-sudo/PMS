"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { getDb } from "@/server/db/client";
import { getCtx, PROPERTY_COOKIE } from "@/server/session";
import { AppError, toSafeError } from "@/server/errors";
import { rateLimit } from "@/server/rateLimit";
import { registerTenant } from "@/server/services/tenant";
import { createBooking } from "@/server/services/booking";
import { rupeesToMinor } from "@/server/money";
import { sendVerification } from "@/server/services/accounts";
import { createRoom, createRoomType, setRoomFloor } from "@/server/services/rooms";
import { assignRoomFloor, createBuilding, createFloor, placeRoom, reorder, setBuildingActive, setFloorActive } from "@/server/services/structure";
import { completeOnboarding, saveStep } from "@/server/services/onboarding";
import { createGuest } from "@/server/services/guests";
import { cancelReservation, checkIn, checkOut, confirmReservation, markNoShow } from "@/server/services/reservations";
import { createMaintenanceRequest, setRoomStatus } from "@/server/services/housekeeping";

const num = (v: FormDataEntryValue | null, d = 0) => (v === null || v === "" ? d : Number(v));
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Lets a form return to the setup wizard step it was shown on; anything else falls back. */
const backTo = (fd: FormData, fallback: string) => (/^\/onboarding\?step=\d$/.test(str(fd.get("back"))) ? str(fd.get("back")) : fallback);

/** Runs a mutation; on failure redirects back with a safe message (no internals leaked). */
async function run(back: string, fn: () => Promise<unknown>, redirectBack = false) {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  if (error) redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}`);
  if (redirectBack) redirect(back);
}

export async function registerAction(fd: FormData) {
  const raw = Object.fromEntries(fd);
  const limited = !rateLimit("register:global", 30, 60 * 60_000);
  let error: string | null = limited ? "Too many sign-ups right now. Try again later." : null;
  if (!error) {
    try {
      const r = await registerTenant(getDb(), raw);
      await sendVerification(getDb(), r.userId);
    } catch (e) {
      error = toSafeError(e).message;
    }
  }
  if (error) redirect(`/register?error=${encodeURIComponent(error)}`);
  await signIn("credentials", { email: str(fd.get("email")), password: str(fd.get("password")), redirectTo: "/onboarding" });
}

export async function loginAction(fd: FormData) {
  try {
    await signIn("credentials", { email: str(fd.get("email")), password: str(fd.get("password")), code: str(fd.get("code")), redirectTo: "/app/dashboard" });
  } catch (e) {
    if (e instanceof AuthError) redirect("/login?error=Invalid%20email%20or%20password");
    throw e;
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}

export async function switchPropertyAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("propertyId"));
  if (ctx.accessiblePropertyIds.includes(id)) {
    (await cookies()).set(PROPERTY_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
  }
  revalidatePath("/app", "layout");
}

export async function addRoomTypeAction(fd: FormData) {
  const ctx = await getCtx();
  await run(backTo(fd, "/app/room-types"), () =>
    createRoomType(getDb(), ctx, {
      name: str(fd.get("name")),
      maxAdults: num(fd.get("maxAdults"), 2),
      maxChildren: num(fd.get("maxChildren"), 0),
      baseRateMinor: Math.round(num(fd.get("baseRate")) * 100),
      baseOccupancy: num(fd.get("baseOccupancy"), 2),
      extraAdultRateMinor: rupeesOpt(str(fd.get("extraAdultRate"))) ?? 0,
      extraChildRateMinor: rupeesOpt(str(fd.get("extraChildRate"))) ?? 0,
      description: str(fd.get("description")) || undefined,
      bedConfig: str(fd.get("bedConfig")) || undefined,
      amenities: str(fd.get("amenities")).split(",").map((s) => s.trim()).filter(Boolean),
    }),
  );
}

export async function addRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const floor = str(fd.get("floor")).trim();
  const floorId = str(fd.get("floorId")).trim();
  await run("/app/rooms", () =>
    createRoom(getDb(), ctx, {
      roomTypeId: str(fd.get("roomTypeId")),
      number: str(fd.get("number")),
      ...(floorId !== "" && { floorId }),
      ...(floorId === "" && floor !== "" && { floor: Number(floor) }),
    }),
  );
}

export async function addBuildingAction(fd: FormData) {
  const ctx = await getCtx();
  await run(backTo(fd, "/app/structure"), () => createBuilding(getDb(), ctx, { name: str(fd.get("name")) }));
}

export async function addFloorAction(fd: FormData) {
  const ctx = await getCtx();
  await run(backTo(fd, "/app/structure"), () =>
    createFloor(getDb(), ctx, { buildingId: str(fd.get("buildingId")), label: str(fd.get("label")), level: num(fd.get("level"), 0) }),
  );
}

export async function structureToggleAction(fd: FormData) {
  const ctx = await getCtx();
  const kind = str(fd.get("kind"));
  const id = str(fd.get("id"));
  const active = str(fd.get("active")) === "true";
  await run("/app/structure", () => (kind === "building" ? setBuildingActive(getDb(), ctx, id, active) : setFloorActive(getDb(), ctx, id, active)));
}

export async function structureReorderAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/structure", () => reorder(getDb(), ctx, { kind: str(fd.get("kind")), id: str(fd.get("id")), direction: str(fd.get("direction")) }));
}

export async function roomAssignFloorAction(fd: FormData) {
  const ctx = await getCtx();
  const floorId = str(fd.get("floorId")).trim();
  await run("/app/rooms", () => assignRoomFloor(getDb(), ctx, str(fd.get("roomId")), floorId === "" ? null : floorId));
}

export async function roomFloorAction(fd: FormData) {
  const ctx = await getCtx();
  const floor = str(fd.get("floor")).trim();
  await run("/app/rooms", () => setRoomFloor(getDb(), ctx, str(fd.get("roomId")), floor === "" ? null : Number(floor)));
}

export async function addGuestAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/guests", () =>
    createGuest(getDb(), ctx, { name: str(fd.get("name")), phone: str(fd.get("phone")) || undefined, email: str(fd.get("email")) || undefined }),
  );
}

/** "10" or "12.5" (percent) -> basis points. */
function percentToBp(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t) || Number(t) > 100) throw new AppError("VALIDATION", "Enter a discount percentage between 0 and 100.");
  const bp = Math.round(Number(t) * 100);
  return bp > 0 ? bp : undefined;
}
const rupeesOpt = (v: string) => (v.trim() ? rupeesToMinor(v) : undefined);

export async function addBookingAction(fd: FormData) {
  const ctx = await getCtx();
  const keep = new URLSearchParams();
  for (const k of ["roomTypeId", "roomId", "arrival", "departure", "rooms", "adults", "children", "discountPct", "discountAmt", "ratePlanId"]) {
    const v = str(fd.get(k));
    if (v) keep.set(k, v);
  }
  keep.set("check", "1");
  let error: string | null = null;
  let dest: string | null = null;
  try {
    const guestId = str(fd.get("guestId"));
    const advanceAmt = rupeesOpt(str(fd.get("advanceAmt")));
    const r = await createBooking(getDb(), ctx, {
      ...(guestId
        ? { guestId, mobile: str(fd.get("g_mobile")) || undefined }
        : {
            newGuest: {
              name: str(fd.get("g_name")), mobile: str(fd.get("g_mobile")), email: str(fd.get("g_email")) || undefined,
              address: str(fd.get("g_address")) || undefined, idType: str(fd.get("g_idType")) || undefined, idNumber: str(fd.get("g_idNumber")) || undefined,
            },
          }),
      roomTypeId: str(fd.get("roomTypeId")), roomId: str(fd.get("roomId")) || undefined, ratePlanId: str(fd.get("ratePlanId")) || undefined,
      arrival: str(fd.get("arrival")), departure: str(fd.get("departure")),
      rooms: num(fd.get("rooms"), 1), adults: num(fd.get("adults"), 1), children: num(fd.get("children"), 0),
      source: str(fd.get("source")) || "WALK_IN", companyName: str(fd.get("companyName")) || undefined, agentName: str(fd.get("agentName")) || undefined, externalRef: str(fd.get("externalRef")) || undefined,
      notes: str(fd.get("notes")) || undefined, status: str(fd.get("status")) || "CONFIRMED",
      discountPercentBp: percentToBp(str(fd.get("discountPct"))), discountAmountMinor: rupeesOpt(str(fd.get("discountAmt"))),
      discountReason: str(fd.get("discountReason")) || undefined,
      ...(advanceAmt ? { advance: { amountMinor: advanceAmt, method: str(fd.get("advanceMethod")) || "CASH", reference: str(fd.get("advanceRef")) || undefined } } : {}),
    });
    const q = r.advance.error ? `?advanceError=${encodeURIComponent(r.advance.error)}` : "";
    dest = `/app/reservations/${r.reservations[0].id}/confirmation${q}`;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  if (error) redirect(`/app/reservations/new?${keep}&error=${encodeURIComponent(error)}`);
  redirect(dest!);
}

export async function reservationAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  const kind = str(fd.get("kind"));
  const back = str(fd.get("back")).startsWith("/app/") ? str(fd.get("back")) : "/app/reservations";
  await run(back, async () => {
    const db = getDb();
    if (kind === "checkin") return checkIn(db, ctx, id);
    if (kind === "confirm") return confirmReservation(db, ctx, id);
    if (kind === "checkout") return checkOut(db, ctx, id, { waiveReason: str(fd.get("waive")).trim() || undefined });
    if (kind === "noshow") return markNoShow(db, ctx, id);
    if (kind === "cancel") return cancelReservation(db, ctx, id, str(fd.get("reason")) || "Cancelled by staff");
  });
}

export async function roomStatusAction(fd: FormData) {
  const ctx = await getCtx();
  const back = str(fd.get("back"));
  const target = /^\/app\/[\w\-/]*(\?[\w=&\-%.]*)?$/.test(back) ? back : "/app/housekeeping";
  await run(target, () => setRoomStatus(getDb(), ctx, str(fd.get("roomId")), str(fd.get("status")) as "CLEAN"), true);
}

export async function maintenanceAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/maintenance", () =>
    createMaintenanceRequest(getDb(), ctx, {
      roomId: str(fd.get("roomId")), title: str(fd.get("title")), blocksRoom: fd.get("blocksRoom") === "on",
    }),
  );
}

export async function placeRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const floorId = str(fd.get("floorId"));
  const x = str(fd.get("x")).trim();
  const y = str(fd.get("y")).trim();
  const clear = str(fd.get("clear")) === "1";
  await run(`/app/rooms/plan?floor=${encodeURIComponent(floorId)}`, () =>
    placeRoom(getDb(), ctx, { roomId: str(fd.get("roomId")), x: clear || x === "" ? null : Number(x) - 1, y: clear || y === "" ? null : Number(y) - 1 }),
  );
}

export async function wizardStepAction(fd: FormData) {
  const ctx = await getCtx();
  const step = Number(str(fd.get("step")));
  await run("/onboarding", () => saveStep(getDb(), ctx, step), false);
  redirect(`/onboarding?step=${step}`);
}

export async function wizardFinishAction() {
  const ctx = await getCtx();
  await run("/onboarding?step=5", () => completeOnboarding(getDb(), ctx));
  redirect("/app/dashboard");
}
