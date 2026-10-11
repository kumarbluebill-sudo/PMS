"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { rateLimit } from "@/server/rateLimit";
import { hashToken } from "@/server/crypto";
import {
  addFeedbackNote, createFeedbackLink, recordFeedback, setComplaintStatus, submitLinkedFeedback,
} from "@/server/services/feedback";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const opt = (v: FormDataEntryValue | null) => str(v).trim() || undefined;

function answers(fd: FormData) {
  return {
    overall: str(fd.get("overall")), cleanliness: str(fd.get("cleanliness")), service: str(fd.get("service")),
    food: str(fd.get("food")), facilities: str(fd.get("facilities")), comments: opt(fd.get("comments")),
    recommend: str(fd.get("recommend")), suggestions: opt(fd.get("suggestions")),
  };
}

/** Same-site relative path only. */
const safeBack = (v: string) => (/^\/app\/[\w\-/]*(\?[\w=&\-%.]*)?$/.test(v) ? v : "/app/feedback");
const withQuery = (path: string, k: string, v: string) => `${path}${path.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;

export async function recordFeedbackAction(fd: FormData) {
  const ctx = await getCtx();
  let error: string | null = null;
  try {
    await recordFeedback(getDb(), ctx, {
      reference: opt(fd.get("reference")), guestName: opt(fd.get("guestName")), roomNumber: opt(fd.get("roomNumber")),
      arrival: opt(fd.get("arrival")), departure: opt(fd.get("departure")), ...answers(fd),
    });
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app/feedback");
  redirect(error ? withQuery("/app/feedback", "error", error) : withQuery("/app/feedback", "ok", "Feedback recorded."));
}

export async function addFeedbackNoteAction(fd: FormData) {
  const ctx = await getCtx();
  const back = safeBack(str(fd.get("back")));
  let error: string | null = null;
  try {
    await addFeedbackNote(getDb(), ctx, str(fd.get("id")), str(fd.get("note")));
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app/feedback");
  redirect(error ? withQuery(back, "error", error) : back);
}

export async function setComplaintStatusAction(fd: FormData) {
  const ctx = await getCtx();
  const back = safeBack(str(fd.get("back")));
  let error: string | null = null;
  try {
    await setComplaintStatus(getDb(), ctx, str(fd.get("id")), str(fd.get("status")));
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(error ? withQuery(back, "error", error) : back);
}

export type LinkResult = { url?: string; expires?: string; error?: string };

/** Creates a guest feedback link and returns its URL once (only a hash is stored). */
export async function createFeedbackLinkAction(_prev: LinkResult, fd: FormData): Promise<LinkResult> {
  const ctx = await getCtx();
  try {
    const { token, expiresAt } = await createFeedbackLink(getDb(), ctx, str(fd.get("reservationId")));
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return { url: `${proto}://${host}/feedback/${token}`, expires: expiresAt.toISOString().slice(0, 10) };
  } catch (e) {
    return { error: toSafeError(e).message };
  }
}

/** Public: no login. Limited per link so a leaked link cannot be hammered. */
export async function submitPublicFeedbackAction(fd: FormData) {
  const token = str(fd.get("token"));
  const path = `/feedback/${encodeURIComponent(token)}`;
  if (!rateLimit(`feedback:${hashToken(token)}`, 10, 60 * 60_000)) redirect(withQuery(path, "error", "Too many attempts. Please try again later."));
  let error: string | null = null;
  try {
    await submitLinkedFeedback(getDb(), token, answers(fd));
  } catch (e) {
    error = toSafeError(e).message;
  }
  redirect(error ? withQuery(path, "error", error) : withQuery(path, "done", "1"));
}
