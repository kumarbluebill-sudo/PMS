"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { modifyReservation } from "@/server/services/confirmation";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Saves a change to a booking's dates or guests, with the total the staff member saw in the preview. */
export async function modifyReservationAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  let error: string | null = null;
  let ok = "";
  try {
    const r = await modifyReservation(getDb(), ctx, id, {
      arrival: str(fd.get("arrival")), departure: str(fd.get("departure")), adults: Number(str(fd.get("adults"))), children: Number(str(fd.get("children"))),
      notes: str(fd.get("notes")) || undefined, reason: str(fd.get("reason")) || undefined, expectedUpdatedAt: str(fd.get("expectedUpdatedAt")) || undefined,
    });
    const shown = Number(str(fd.get("previewTotal")));
    ok = Number.isFinite(shown) && shown !== r.newTotalMinor
      ? "Booking changed, but the total differs from the preview because prices changed in the meantime. Check the new total."
      : "Booking changed. The new total is saved and the change is recorded.";
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(`/app/reservations/${id}?${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}
