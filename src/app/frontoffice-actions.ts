"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { toSafeError } from "@/server/errors";
import { getCtx } from "@/server/session";
import { setAlertState } from "@/server/services/alerts";
import { assignRoom, checkInGuarded, confirmNoShow, recordRegistration, setRequests, verifyId } from "@/server/services/frontoffice";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const opt = (v: FormDataEntryValue | null) => str(v).trim() || undefined;

/** Same-site app paths only, so a forged form cannot send the user elsewhere. */
const safeBack = (v: string, fallback: string) => (/^\/app\/[\w\-/?=&#%.]*$/.test(v) ? v : fallback);

async function go(back: string, fn: () => Promise<string | void>): Promise<never> {
  let msg = "";
  let failed = false;
  try {
    msg = (await fn()) ?? "";
  } catch (e) {
    msg = toSafeError(e).message;
    failed = true;
  }
  revalidatePath("/app", "layout");
  const sep = back.includes("?") ? "&" : "?";
  redirect(`${back}${sep}${failed ? "error" : "ok"}=${encodeURIComponent(msg || "Done.")}`);
}

export async function assignRoomAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("reservationId"));
  await go(safeBack(str(fd.get("back")), `/app/check-in/${id}`), async () => {
    await assignRoom(getDb(), ctx, { reservationId: id, roomId: str(fd.get("roomId")), reason: opt(fd.get("reason")) });
    return "Room assigned.";
  });
}

export async function registrationAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("reservationId"));
  const num = (k: string) => (str(fd.get(k)).trim() === "" ? undefined : Number(str(fd.get(k))));
  await go(`/app/check-in/${id}`, async () => {
    const r = await recordRegistration(getDb(), ctx, {
      reservationId: id, phone: opt(fd.get("phone")), email: opt(fd.get("email")), idType: opt(fd.get("idType")), idNumber: opt(fd.get("idNumber")),
      adults: num("adults"), children: num("children"),
    });
    return r.complete ? "Registration complete." : `Saved. Still missing: ${r.issues.join(", ").toLowerCase()}.`;
  });
}

export async function verifyIdAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("reservationId"));
  await go(`/app/check-in/${id}`, async () => {
    await verifyId(getDb(), ctx, id);
    return "ID marked as verified.";
  });
}

export async function requestsAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("reservationId"));
  await go(`/app/check-in/${id}`, async () => {
    await setRequests(getDb(), ctx, {
      reservationId: id, vip: str(fd.get("vip")) === "on", etaTime: str(fd.get("etaTime")), earlyCheckinRequest: str(fd.get("early")), lateCheckoutRequest: str(fd.get("late")),
    });
    return "Requests saved.";
  });
}

export async function guardedCheckInAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("reservationId"));
  const back = `/app/check-in/${id}`;
  let failed: string | null = null;
  try {
    await checkInGuarded(getDb(), ctx, id);
  } catch (e) {
    failed = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  if (failed) redirect(`${back}?error=${encodeURIComponent(failed)}`);
  redirect(`/app/check-in/${id}/confirmation`);
}

export async function noShowAction(fd: FormData) {
  const ctx = await getCtx();
  await go(safeBack(str(fd.get("back")), "/app/operations"), async () => {
    await confirmNoShow(getDb(), ctx, str(fd.get("reservationId")), str(fd.get("note")));
    return "Marked as a no-show.";
  });
}

export async function alertStateAction(fd: FormData) {
  const ctx = await getCtx();
  await go(safeBack(str(fd.get("back")), "/app/alerts"), async () => {
    await setAlertState(getDb(), ctx, { key: str(fd.get("key")), status: str(fd.get("status")), note: opt(fd.get("note")) });
    return "Alert updated.";
  });
}
