"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { AppError, toSafeError } from "@/server/errors";
import { rupeesToMinor } from "@/server/money";
import {
  archiveRoom, bulkAssignFloor, createCategoryFull, createRatePlan, createRoomsBulk, deleteCategory, deleteFloorOrBuilding, deleteProperty, deleteRatePlan, deleteRoom,
  duplicateRatePlan, reactivateRoom, reassignRooms, setCategoryActive, setPropertyStatus, setRatePlanActive, updateCategory, updateFloorOrBuilding, updatePropertyProfile,
  updateRatePlan, updateRoom,
} from "@/server/services/property";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const int = (v: FormDataEntryValue | null, d = 0) => (str(v).trim() === "" ? d : Number(str(v)));

/** Same-site Property Management paths only. */
const SAFE_BACK = /^\/app\/(property|rooms|room-types|rates|structure|settings\/property)(\/[0-9a-f-]{36})?(\/new)?(\?[\w=&%.\-+]*)?$/;
const backOf = (fd: FormData, fallback: string) => (SAFE_BACK.test(str(fd.get("back"))) ? str(fd.get("back")) : fallback);

/** Runs the change, then returns to `back` with a success or error banner. Messages never include internals. */
async function done(back: string, fn: () => Promise<unknown>, ok: string) {
  let error: string | null = null;
  const dest = back;
  try {
    await fn();
  } catch (e) {
    if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  const sep = dest.includes("?") ? "&" : "?";
  redirect(`${dest}${sep}${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}

/** Rupees field to paise. Blank means "not set". */
const rs = (fd: FormData, k: string): number | undefined => {
  const v = str(fd.get(k)).trim();
  if (v === "") return undefined;
  try { return rupeesToMinor(v); } catch { throw new AppError("VALIDATION", `Enter an amount like 1250 or 1250.50 for ${k.replace(/_/g, " ")}.`); }
};
const list = (v: string, sep: RegExp) => v.split(sep).map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- categories

function categoryInput(fd: FormData) {
  return {
    name: str(fd.get("name")), code: str(fd.get("code")), description: str(fd.get("description")),
    baseOccupancy: int(fd.get("baseOccupancy"), 2), maxAdults: int(fd.get("maxAdults"), 2), maxChildren: int(fd.get("maxChildren"), 0),
    bedConfig: str(fd.get("bedConfig")), amenities: list(str(fd.get("amenities")), /,/), imageUrls: list(str(fd.get("imageUrls")), /[\s,]+/),
    baseRateMinor: rs(fd, "baseRate") ?? 0, extraAdultRateMinor: rs(fd, "extraAdultRate") ?? 0, extraChildRateMinor: rs(fd, "extraChildRate") ?? 0,
    expectedUpdatedAt: str(fd.get("expectedUpdatedAt")) || undefined,
  };
}

export async function addCategoryAction(fd: FormData) {
  const ctx = await getCtx();
  await done("/app/room-types", () => createCategoryFull(getDb(), ctx, categoryInput(fd)), "Category added.");
}

export async function saveCategoryAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await done(`/app/room-types/${id}`, () => updateCategory(getDb(), ctx, id, categoryInput(fd)), "Category saved. Existing bookings keep the rates they were booked at.");
}

export async function categoryActiveAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  const active = str(fd.get("active")) === "true";
  await done(`/app/room-types/${id}`, () => setCategoryActive(getDb(), ctx, id, active, str(fd.get("reason"))), active ? "Category reactivated." : "Category deactivated. It no longer appears in new bookings; history is kept.");
}

export async function reassignRoomsAction(fd: FormData) {
  const ctx = await getCtx();
  const from = str(fd.get("fromTypeId"));
  await done(`/app/room-types/${from}`, () => reassignRooms(getDb(), ctx, { fromTypeId: from, toTypeId: str(fd.get("toTypeId")), roomIds: fd.getAll("roomIds").map(String) }), "Rooms moved to the new category.");
}

export async function deleteCategoryAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  let blocked: string | null = null;
  try { await deleteCategory(getDb(), ctx, id); } catch (e) { blocked = toSafeError(e).message; }
  revalidatePath("/app", "layout");
  if (blocked) redirect(`/app/room-types/${id}?error=${encodeURIComponent(blocked)}`);
  redirect(`/app/room-types?ok=${encodeURIComponent("Category deleted.")}`);
}

// ---------------------------------------------------------------- rooms

export async function saveRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await done(`/app/rooms/${id}`, () => updateRoom(getDb(), ctx, id, {
    number: str(fd.get("number")), name: str(fd.get("name")), roomTypeId: str(fd.get("roomTypeId")), floorId: str(fd.get("floorId")) || null,
    notes: str(fd.get("notes")), expectedUpdatedAt: str(fd.get("expectedUpdatedAt")) || undefined,
  }), "Room saved.");
}

export async function archiveRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await done(backOf(fd, `/app/rooms/${id}`), () => archiveRoom(getDb(), ctx, id, str(fd.get("reason"))), "Room archived. It no longer appears in availability; its history is kept.");
}

export async function reactivateRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await done(backOf(fd, `/app/rooms/${id}`), () => reactivateRoom(getDb(), ctx, id), "Room reactivated.");
}

export async function deleteRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  let blocked: string | null = null;
  try { await deleteRoom(getDb(), ctx, id); } catch (e) { blocked = toSafeError(e).message; }
  revalidatePath("/app", "layout");
  if (blocked) redirect(`/app/rooms/${id}?error=${encodeURIComponent(blocked)}`);
  redirect(`/app/rooms?ok=${encodeURIComponent("Room deleted.")}`);
}

export async function bulkRoomsAction(fd: FormData) {
  const ctx = await getCtx();
  await done("/app/rooms", () => createRoomsBulk(getDb(), ctx, {
    roomTypeId: str(fd.get("roomTypeId")), floorId: str(fd.get("floorId")) || undefined, prefix: str(fd.get("prefix")), suffix: str(fd.get("suffix")),
    from: int(fd.get("from")), to: int(fd.get("to")),
  }), "Rooms created.");
}

// ---------------------------------------------------------------- floors and buildings

export async function renameFloorOrBuildingAction(fd: FormData) {
  const ctx = await getCtx();
  const kind = str(fd.get("kind")) === "floor" ? "floor" : "building";
  await done("/app/structure", () => updateFloorOrBuilding(getDb(), ctx, { kind, id: str(fd.get("id")), name: str(fd.get("name")), ...(kind === "floor" && str(fd.get("level")) !== "" ? { level: int(fd.get("level")) } : {}) }), "Saved.");
}

export async function deleteFloorOrBuildingAction(fd: FormData) {
  const ctx = await getCtx();
  const kind = str(fd.get("kind")) === "floor" ? "floor" : "building";
  await done("/app/structure", () => deleteFloorOrBuilding(getDb(), ctx, kind, str(fd.get("id"))), kind === "floor" ? "Floor deleted." : "Building deleted.");
}

export async function bulkAssignFloorAction(fd: FormData) {
  const ctx = await getCtx();
  await done("/app/structure", () => bulkAssignFloor(getDb(), ctx, { floorId: str(fd.get("floorId")), roomIds: fd.getAll("roomIds").map(String) }), "Rooms assigned to the floor.");
}

// ---------------------------------------------------------------- rate plans

function planInput(fd: FormData) {
  const rates = fd.getAll("typeIds").map(String).flatMap((tid) => {
    const weekday = rs(fd, `weekday_${tid}`);
    if (weekday === undefined) return [];
    return [{
      roomTypeId: tid, weekdayRateMinor: weekday, weekendRateMinor: rs(fd, `weekend_${tid}`) ?? null, singleOccupancyRateMinor: rs(fd, `single_${tid}`) ?? null,
      extraAdultRateMinor: rs(fd, `extraAdult_${tid}`) ?? null, extraChildRateMinor: rs(fd, `extraChild_${tid}`) ?? null,
    }];
  });
  return {
    name: str(fd.get("name")), code: str(fd.get("code")), description: str(fd.get("description")), active: fd.get("active") === "on",
    validFrom: str(fd.get("validFrom")), validTo: str(fd.get("validTo")), priority: int(fd.get("priority")),
    weekendDays: fd.getAll("weekend").map(Number), mealPlan: str(fd.get("mealPlan")) || "ROOM_ONLY", refundable: fd.get("refundable") === "on",
    minStay: str(fd.get("minStay")) ? int(fd.get("minStay")) : null, maxStay: str(fd.get("maxStay")) ? int(fd.get("maxStay")) : null,
    taxNote: str(fd.get("taxNote")), rates, expectedUpdatedAt: str(fd.get("expectedUpdatedAt")) || undefined,
  };
}

export async function saveRatePlanAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  if (id) await done(`/app/rates/${id}`, () => updateRatePlan(getDb(), ctx, id, planInput(fd)), "Rate plan saved. Existing bookings keep the rates they were booked at.");
  else {
    let newId: string | null = null;
    let error: string | null = null;
    try { newId = (await createRatePlan(getDb(), ctx, planInput(fd))).id; } catch (e) { error = toSafeError(e).message; }
    revalidatePath("/app", "layout");
    if (error) redirect(`/app/rates/new?error=${encodeURIComponent(error)}`);
    redirect(`/app/rates/${newId}?ok=${encodeURIComponent("Rate plan created.")}`);
  }
}

export async function duplicateRatePlanAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await done("/app/rates", () => duplicateRatePlan(getDb(), ctx, id), "Plan duplicated. The copy is archived until you set its dates or priority and reactivate it.");
}

export async function ratePlanActiveAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  const active = str(fd.get("active")) === "true";
  await done(backOf(fd, "/app/rates"), () => setRatePlanActive(getDb(), ctx, id, active), active ? "Rate plan reactivated." : "Rate plan archived. Existing bookings keep their rates.");
}

export async function deleteRatePlanAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  let blocked: string | null = null;
  try { await deleteRatePlan(getDb(), ctx, id); } catch (e) { blocked = toSafeError(e).message; }
  revalidatePath("/app", "layout");
  if (blocked) redirect(`/app/rates/${id}?error=${encodeURIComponent(blocked)}`);
  redirect(`/app/rates?ok=${encodeURIComponent("Rate plan deleted.")}`);
}

// ---------------------------------------------------------------- property

export async function saveProfileAction(fd: FormData) {
  const ctx = await getCtx();
  await done("/app/settings/property", () => updatePropertyProfile(getDb(), ctx, {
    name: str(fd.get("name")), code: str(fd.get("code")), address: str(fd.get("address")), operationalAddress: str(fd.get("operationalAddress")),
    phone: str(fd.get("phone")), email: str(fd.get("email")), timezone: str(fd.get("timezone")), currency: str(fd.get("currency")),
    checkInTime: str(fd.get("checkInTime")), checkOutTime: str(fd.get("checkOutTime")), description: str(fd.get("description")),
    amenities: list(str(fd.get("amenities")), /,/), logoUrl: str(fd.get("logoUrl")), imageUrls: list(str(fd.get("imageUrls")), /[\s,]+/),
    expectedUpdatedAt: str(fd.get("expectedUpdatedAt")) || undefined,
  }), "Property profile saved.");
}

export async function propertyStatusAction(fd: FormData) {
  const ctx = await getCtx();
  const status = str(fd.get("status")) as "ACTIVE" | "INACTIVE" | "ARCHIVED";
  await done("/app/settings/property", () => setPropertyStatus(getDb(), ctx, status, str(fd.get("reason"))), status === "ACTIVE" ? "Property reactivated." : "Property status updated.");
}

export async function deletePropertyAction(fd: FormData) {
  const ctx = await getCtx();
  await done("/app/settings/property", () => deleteProperty(getDb(), ctx, str(fd.get("id"))), "Property deleted.");
}
