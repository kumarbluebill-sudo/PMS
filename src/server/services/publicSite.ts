import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rateLimit";
import { deliverEmail } from "./emailOutbox";
import { platformSettings } from "./subscription";

/** Plans and add-ons exactly as the platform administrator has set them. The pricing page renders from this, never from constants. */
export async function listPublicPlans(db: PrismaClient) {
  const [plans, addons] = await Promise.all([
    db.plan.findMany({ where: { active: true, isPublic: true }, orderBy: { sortOrder: "asc" } }),
    db.planAddon.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);
  const gstBps = (await db.$transaction((tx) => platformSettings(tx)))["saas.gstBps"];
  return { plans, addons, gstBps };
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optInt = (max: number) => z.preprocess(blank, z.coerce.number().int().min(1).max(max).optional());

export const leadSchema = z.object({
  kind: z.enum(["CONTACT", "DEMO"]).default("CONTACT"),
  name: z.string().trim().min(2, "Enter your name.").max(100),
  hotel: z.string().trim().min(2, "Enter your hotel's name.").max(120),
  mobile: z.string().trim().transform((s) => s.replace(/[\s()-]/g, "")).pipe(z.string().regex(/^(\+91|91|0)?[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number.")),
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(200),
  rooms: optInt(5000),
  properties: optInt(500),
  integrations: z.string().trim().max(300).optional(),
  message: z.string().trim().max(2000).optional(),
  /** A field real visitors never see. Bots that fill it are dropped without a trace. */
  website: z.string().optional(),
});

export const ipHash = (ip: string) => createHash("sha256").update(`${process.env.AUTH_SECRET ?? "lead"}:${ip}`).digest("hex").slice(0, 32);

/**
 * Stores a contact or demo request and tells the sales address. Validated, rate limited per visitor and overall, and
 * the honeypot field silently drops bots. Nothing here asks for or stores payment or password details.
 */
export async function createLead(db: PrismaClient, input: unknown, visitor: string) {
  const d = leadSchema.parse(input);
  if (d.website && d.website.trim() !== "") return { stored: false as const };
  const key = ipHash(visitor);
  if (!rateLimit(`lead:${key}`, 5, 60 * 60_000) || !rateLimit("lead:all", 200, 60 * 60_000)) {
    throw new AppError("VALIDATION", "Too many requests. Please try again in a little while.");
  }
  const lead = await db.lead.create({
    data: {
      kind: d.kind, name: d.name, hotel: d.hotel, mobile: d.mobile, email: d.email, rooms: d.rooms ?? null, properties: d.properties ?? null,
      integrations: d.integrations || null, message: d.message || null, ipHash: key,
    },
  });
  const to = (await db.$transaction((tx) => platformSettings(tx)))["saas.salesEmail"];
  if (to) {
    await deliverEmail(db, {
      kind: "ACCOUNT", to, idempotencyKey: `lead:${lead.id}`,
      subject: `${d.kind === "DEMO" ? "Demo request" : "Enquiry"}: ${d.hotel}`,
      text: `${d.name} from ${d.hotel} wrote to you.\n\nMobile: ${d.mobile}\nEmail: ${d.email}\nRooms: ${d.rooms ?? "-"}\nProperties: ${d.properties ?? "-"}\nIntegrations: ${d.integrations ?? "-"}\n\n${d.message ?? ""}`,
    }).catch(() => undefined);
  }
  return { stored: true as const, id: lead.id };
}
