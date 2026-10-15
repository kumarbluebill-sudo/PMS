"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { markNotificationsRead } from "@/server/services/notifications";

/** Marks the shown notifications as read for this user only; other staff still see them as new. */
export async function markNotificationsReadAction(fd: FormData) {
  const ctx = await getCtx();
  const ids = fd.getAll("id").map(String).filter(Boolean);
  await markNotificationsRead(getDb(), ctx, ids.length ? ids : undefined);
  revalidatePath("/app", "layout");
  redirect("/app/alerts");
}
