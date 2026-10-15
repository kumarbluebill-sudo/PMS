"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { toSafeError } from "@/server/errors";
import { rupeesToMinor } from "@/server/money";
import { requirePlatform } from "@/server/platform";
import {
  adminAction, adminFailPayment, adminIssueRenewal, adminRecordPayment, adminVoidInvoice, savePlatformSettings, setLeadStatus, upsertAddon, upsertCoupon, upsertPlan,
} from "@/server/services/platform";
import { FEATURES } from "@/server/domain/subscription";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const intOrNull = (v: FormDataEntryValue | null) => (str(v).trim() === "" ? null : Math.round(Number(str(v))));
const rupeesOrNull = (v: FormDataEntryValue | null) => (str(v).trim() === "" ? null : rupeesToMinor(str(v)));
const dateOrNull = (v: FormDataEntryValue | null) => (str(v).trim() === "" ? null : new Date(`${str(v)}T00:00:00Z`));

async function go(back: string, fn: () => Promise<string | void>, okText = "Saved.") {
  let error: string | null = null;
  let ok = okText;
  try {
    const r = await fn();
    if (typeof r === "string" && r) ok = r;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/platform", "layout");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}
const hotelPage = (id: string) => `/platform/subscriptions/${id}`;

export async function subscriptionActionAction(fd: FormData) {
  const p = await requirePlatform();
  const tenantId = str(fd.get("tenantId"));
  await go(hotelPage(tenantId), async () => {
    const action = str(fd.get("action"));
    const base = { tenantId, reason: str(fd.get("reason")) };
    if (action === "EXTEND_TRIAL") await adminAction(getDb(), p, { ...base, action, days: Number(str(fd.get("days"))) });
    else if (action === "CHANGE_PLAN") {
      await adminAction(getDb(), p, { ...base, action, planCode: str(fd.get("planCode")), interval: str(fd.get("interval")) === "ANNUAL" ? "ANNUAL" : "MONTHLY", priceOverrideMinor: rupeesOrNull(fd.get("priceOverride")) });
    } else if (action === "ACTIVATE" || action === "SUSPEND" || action === "CANCEL" || action === "NOTE") await adminAction(getDb(), p, { ...base, action });
    else throw new Error("Choose an action.");
  }, "Done.");
}

export async function recordPaymentAction(fd: FormData) {
  const p = await requirePlatform();
  const tenantId = str(fd.get("tenantId"));
  await go(hotelPage(tenantId), async () => {
    const r = await adminRecordPayment(getDb(), p, tenantId, {
      invoiceId: str(fd.get("invoiceId")), amountMinor: rupeesToMinor(str(fd.get("amount"))), method: str(fd.get("method")),
      reference: str(fd.get("reference")), idempotencyKey: str(fd.get("key")), note: str(fd.get("note")) || undefined,
    });
    return r.duplicate ? "That payment was already recorded." : "Payment recorded.";
  });
}
export async function failPaymentAction(fd: FormData) {
  const p = await requirePlatform();
  const tenantId = str(fd.get("tenantId"));
  await go(hotelPage(tenantId), () => adminFailPayment(getDb(), p, tenantId, { invoiceId: str(fd.get("invoiceId")), reason: str(fd.get("reason")), retryInDays: Number(str(fd.get("days")) || 3) }), "Failed attempt recorded. The reminder date has moved.");
}
export async function voidInvoiceAction(fd: FormData) {
  const p = await requirePlatform();
  const tenantId = str(fd.get("tenantId"));
  await go(hotelPage(tenantId), () => adminVoidInvoice(getDb(), p, tenantId, str(fd.get("invoiceId")), str(fd.get("reason"))), "Invoice cancelled.");
}
export async function issueRenewalAction(fd: FormData) {
  const p = await requirePlatform();
  const tenantId = str(fd.get("tenantId"));
  await go(hotelPage(tenantId), async () => { await adminIssueRenewal(getDb(), p, tenantId); }, "Renewal invoice created.");
}

export async function savePlanAction(fd: FormData) {
  const p = await requirePlatform();
  await go("/platform/plans", async () => {
    await upsertPlan(getDb(), p, {
      code: str(fd.get("code")), name: str(fd.get("name")), description: str(fd.get("description")),
      active: fd.get("active") === "on", isPublic: fd.get("isPublic") === "on", customPricing: fd.get("customPricing") === "on",
      sortOrder: Number(str(fd.get("sortOrder")) || 0), monthlyPriceMinor: rupeesToMinor(str(fd.get("monthlyPrice")) || "0"),
      annualPriceMinor: rupeesOrNull(fd.get("annualPrice")), annualDiscountBps: Math.round(Number(str(fd.get("annualDiscountPct")) || 0) * 100),
      trialDays: Number(str(fd.get("trialDays")) || 0),
      maxProperties: intOrNull(fd.get("maxProperties")), maxRooms: intOrNull(fd.get("maxRooms")), maxUsers: intOrNull(fd.get("maxUsers")),
      maxStorageMb: intOrNull(fd.get("maxStorageMb")), maxIntegrations: intOrNull(fd.get("maxIntegrations")),
      features: Object.fromEntries(FEATURES.map((f) => [f.key, fd.get(`f_${f.key}`) === "on"])),
    });
  }, "Plan saved. The pricing page shows it straight away.");
}
export async function saveAddonAction(fd: FormData) {
  const p = await requirePlatform();
  await go("/platform/plans", async () => {
    await upsertAddon(getDb(), p, { code: str(fd.get("code")), name: str(fd.get("name")), description: str(fd.get("description")), monthlyPriceMinor: rupeesToMinor(str(fd.get("monthlyPrice")) || "0"), active: fd.get("active") === "on" });
  }, "Add-on saved.");
}
export async function saveCouponAction(fd: FormData) {
  const p = await requirePlatform();
  await go("/platform/coupons", async () => {
    const kind = str(fd.get("kind")) === "AMOUNT" ? "AMOUNT" : "PERCENT";
    await upsertCoupon(getDb(), p, {
      code: str(fd.get("code")), description: str(fd.get("description")), kind,
      value: kind === "PERCENT" ? Math.round(Number(str(fd.get("value"))) * 100) : rupeesToMinor(str(fd.get("value"))),
      months: Number(str(fd.get("months")) || 1), startsAt: dateOrNull(fd.get("startsAt")), endsAt: dateOrNull(fd.get("endsAt")),
      maxRedemptions: intOrNull(fd.get("maxRedemptions")), planCodes: str(fd.get("planCodes")).split(",").map((s) => s.trim()).filter(Boolean), active: fd.get("active") === "on",
    });
  }, "Coupon saved.");
}
export async function saveSettingsAction(fd: FormData) {
  const p = await requirePlatform();
  await go("/platform/settings", async () => {
    await savePlatformSettings(getDb(), p, {
      "saas.legalName": str(fd.get("legalName")), "saas.gstin": str(fd.get("gstin")), "saas.address": str(fd.get("address")), "saas.stateCode": str(fd.get("stateCode")),
      "saas.sacCode": str(fd.get("sacCode")), "saas.gstBps": Math.round(Number(str(fd.get("gstPct")) || 0) * 100), "saas.invoicePrefix": str(fd.get("invoicePrefix")),
      "saas.paymentInstructions": str(fd.get("paymentInstructions")), "saas.salesEmail": str(fd.get("salesEmail")),
      "saas.defaultTrialDays": Number(str(fd.get("defaultTrialDays"))), "saas.defaultPlanCode": str(fd.get("defaultPlanCode")),
      "saas.graceDays": Number(str(fd.get("graceDays"))), "saas.renewalLeadDays": Number(str(fd.get("renewalLeadDays"))),
      "saas.expireAfterSuspendedDays": Number(str(fd.get("expireAfterSuspendedDays"))), "saas.pastDueReadOnly": fd.get("pastDueReadOnly") === "on",
    });
  }, "Settings saved.");
}
export async function leadStatusAction(fd: FormData) {
  const p = await requirePlatform();
  const s = str(fd.get("status"));
  await go("/platform/leads", () => setLeadStatus(getDb(), p, str(fd.get("id")), s === "CONTACTED" ? "CONTACTED" : s === "CLOSED" ? "CLOSED" : "NEW"), "Updated.");
}
