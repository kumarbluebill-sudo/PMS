"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { AppError, toSafeError } from "@/server/errors";
import { rupeesToMinor } from "@/server/money";
import { setSettings } from "@/server/services/settings";
import { applyPreset, confirmGstSetup, createRule, gstSetupStatus, updateGstSettings } from "@/server/services/tax";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const opt = (fd: FormData, k: string) => (str(fd.get(k)).trim() === "" ? undefined : str(fd.get(k)).trim());

/** Runs one wizard step, then returns to the step the person was on (or the next one) with a banner. */
async function step(fd: FormData, current: number, next: number, fn: () => Promise<string | void>) {
  let error: string | null = null;
  let ok = "Saved.";
  try {
    const r = await fn();
    if (typeof r === "string" && r) ok = r;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  const to = error ? current : next;
  redirect(`/app/settings/tax/setup?step=${to}&${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}

/** Step 2: registration status and legal details. The change is recorded with a fixed reason. */
export async function wizardLegalAction(fd: FormData) {
  const ctx = await getCtx();
  await step(fd, 2, 3, async () => {
    await updateGstSettings(getDb(), ctx, {
      gstRegistered: fd.get("gstRegistered") === "on", gstin: opt(fd, "gstin"), legalName: opt(fd, "legalName"), address: opt(fd, "address"),
      invoicePrefix: opt(fd, "invoicePrefix") ?? "INV",
    }, "GST setup wizard");
    return "Registration details saved.";
  });
}

/** Step 5: add the rules of a preset as drafts. */
export async function wizardPresetAction(fd: FormData) {
  const ctx = await getCtx();
  await step(fd, 5, 5, async () => {
    const r = await applyPreset(getDb(), ctx, str(fd.get("presetId")));
    return r.created ? `${r.created} draft rule(s) added from "${r.title}". Another authorised person must approve them.` : "Those rules are already in the list; nothing was added.";
  });
}

/** Step 6: one draft rule for a service category the hotel configures itself. */
export async function wizardRuleAction(fd: FormData) {
  const ctx = await getCtx();
  await step(fd, 6, 6, async () => {
    await createRule(getDb(), ctx, {
      category: str(fd.get("category")), sacCode: opt(fd, "sacCode"), description: str(fd.get("description")) || `${str(fd.get("category"))} services`,
      treatment: str(fd.get("treatment")) || "TAXABLE", ratePercent: Number(str(fd.get("ratePercent")) || 0), cessPercent: 0,
      placeOfSupply: str(fd.get("placeOfSupply")) || "PROPERTY_STATE", effectiveFrom: str(fd.get("effectiveFrom")), effectiveTo: opt(fd, "effectiveTo"),
      tariffMinMinor: opt(fd, "tariffMin") ? rupeesToMinor(opt(fd, "tariffMin")!) : undefined, tariffMaxMinor: opt(fd, "tariffMax") ? rupeesToMinor(opt(fd, "tariffMax")!) : undefined,
      legalRef: opt(fd, "legalRef"),
    });
    return "Draft rule saved. It has no effect until another authorised person approves it.";
  });
}

/** Step 7: whether prices are entered with or without GST by default. */
export async function wizardPricingModeAction(fd: FormData) {
  const ctx = await getCtx();
  await step(fd, 7, 8, async () => {
    await setSettings(getDb(), ctx, { "billing.taxInclusiveDefault": str(fd.get("mode")) === "inclusive" });
    return "Default pricing mode saved.";
  });
}

/** Step 8: the invoice prefix, allowed only before any invoice exists. */
export async function wizardPrefixAction(fd: FormData) {
  const ctx = await getCtx();
  await step(fd, 8, 9, async () => {
    const s = await gstSetupStatus(getDb(), ctx);
    if (s.invoicesIssued > 0) throw new AppError("CONFLICT", "The invoice prefix cannot change after invoices have been issued.");
    await updateGstSettings(getDb(), ctx, {
      gstRegistered: s.property.gstRegistered, gstin: s.property.gstin ?? undefined, legalName: s.property.legalName ?? undefined, address: s.property.address ?? undefined,
      invoicePrefix: str(fd.get("invoicePrefix")) || "INV",
    }, "GST setup wizard: invoice prefix");
    return "Invoice prefix saved.";
  });
}

/** Step 10: record that the accountant reviewed the setup. */
export async function wizardConfirmAction(fd: FormData) {
  const ctx = await getCtx();
  await step(fd, 10, 10, async () => {
    await confirmGstSetup(getDb(), ctx, { reviewed: fd.get("reviewed") === "on" });
    return "GST setup confirmed and recorded.";
  });
}
