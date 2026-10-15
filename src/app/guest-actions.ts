"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { updateGuest } from "@/server/services/guests";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Saves the guest's master profile (every booking sees it). Returns to the guest page with a banner. */
export async function saveGuestAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  let error: string | null = null;
  try {
    await updateGuest(getDb(), ctx, id, {
      name: str(fd.get("name")), phone: str(fd.get("phone")), email: str(fd.get("email")), nationality: str(fd.get("nationality")),
      preferences: str(fd.get("preferences")), notes: str(fd.get("notes")), address: str(fd.get("address")), companyName: str(fd.get("companyName")),
      expectedUpdatedAt: str(fd.get("expectedUpdatedAt")) || undefined,
    });
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(`/app/guests/${id}?${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent("Guest profile saved. Existing bookings keep their own details.")}`}`);
}
