"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { getDb } from "@/server/db/client";
import { getCtx, PROPERTY_COOKIE } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { rateLimit } from "@/server/rateLimit";
import { registerTenant } from "@/server/services/tenant";
import { sendVerification } from "@/server/services/accounts";
import { createRoom, createRoomType, setRoomFloor } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { cancelReservation, checkIn, checkOut, createReservation, markNoShow } from "@/server/services/reservations";
import { createMaintenanceRequest, setRoomStatus } from "@/server/services/housekeeping";

const num = (v: FormDataEntryValue | null, d = 0) => (v === null || v === "" ? d : Number(v));
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

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
  await run("/app/room-types", () =>
    createRoomType(getDb(), ctx, {
      name: str(fd.get("name")),
      maxAdults: num(fd.get("maxAdults"), 2),
      maxChildren: num(fd.get("maxChildren"), 0),
      baseRateMinor: Math.round(num(fd.get("baseRate")) * 100),
    }),
  );
}

export async function addRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const floor = str(fd.get("floor")).trim();
  await run("/app/rooms", () =>
    createRoom(getDb(), ctx, { roomTypeId: str(fd.get("roomTypeId")), number: str(fd.get("number")), ...(floor !== "" && { floor: Number(floor) }) }),
  );
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

export async function addReservationAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/reservations", () =>
    createReservation(getDb(), ctx, {
      guestId: str(fd.get("guestId")),
      roomTypeId: str(fd.get("roomTypeId")),
      arrival: str(fd.get("arrival")),
      departure: str(fd.get("departure")),
      adults: num(fd.get("adults"), 1),
      children: num(fd.get("children"), 0),
      source: str(fd.get("source")) || "DIRECT",
    }),
  );
}

export async function reservationAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  const kind = str(fd.get("kind"));
  const back = str(fd.get("back")).startsWith("/app/") ? str(fd.get("back")) : "/app/reservations";
  await run(back, async () => {
    const db = getDb();
    if (kind === "checkin") return checkIn(db, ctx, id);
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
