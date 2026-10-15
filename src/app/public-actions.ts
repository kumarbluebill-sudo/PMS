"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { getDb } from "@/server/db/client";
import { toSafeError } from "@/server/errors";
import { createLead } from "@/server/services/publicSite";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** The contact and demo form. Returns to the page with a clear message; the visitor's address is only kept as a hash. */
export async function contactAction(fd: FormData) {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  const kind = str(fd.get("kind")) === "DEMO" ? "DEMO" : "CONTACT";
  let error: string | null = null;
  try {
    await createLead(getDb(), {
      kind, name: str(fd.get("name")), hotel: str(fd.get("hotel")), mobile: str(fd.get("mobile")), email: str(fd.get("email")),
      rooms: str(fd.get("rooms")), properties: str(fd.get("properties")), integrations: str(fd.get("integrations")) || undefined,
      message: str(fd.get("message")) || undefined, website: str(fd.get("website")),
    }, ip);
  } catch (e) {
    error = e instanceof ZodError ? (e.issues[0]?.message ?? "Some fields are invalid.") : toSafeError(e).message;
  }
  redirect(error ? `/contact?${kind === "DEMO" ? "demo=1&" : ""}error=${encodeURIComponent(error)}` : "/contact?sent=1");
}
