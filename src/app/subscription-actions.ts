"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { applyCouponCode, cancelSubscription, changePlan, clearScheduledChange, resumeSubscription } from "@/server/services/subscription";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const HOME = "/app/settings/subscription";

/** Runs one subscription action and returns to the page with a plain message either way. */
async function go(fn: () => Promise<string | void>, okText: string) {
  let error: string | null = null;
  let ok = okText;
  try {
    const r = await fn();
    if (typeof r === "string" && r) ok = r;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(`${HOME}?${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}

export async function changePlanAction(fd: FormData) {
  const ctx = await getCtx();
  await go(async () => {
    const r = await changePlan(getDb(), ctx, { planCode: str(fd.get("planCode")), interval: str(fd.get("interval")) });
    return r.mode === "UPGRADE" ? "Plan upgraded. An invoice for the difference is below." : r.mode === "SCHEDULE" ? `Plan change saved. It takes effect ${r.effective}.` : "Invoice created. Your plan starts when the payment is recorded.";
  }, "Saved.");
}
export async function cancelSubscriptionAction(fd: FormData) {
  const ctx = await getCtx();
  await go(() => cancelSubscription(getDb(), ctx, str(fd.get("reason"))), "Cancellation set. Your plan runs to the end of the period you paid for.");
}
export async function resumeSubscriptionAction() {
  const ctx = await getCtx();
  await go(() => resumeSubscription(getDb(), ctx), "Cancellation undone. Your plan will renew as usual.");
}
export async function clearScheduledChangeAction() {
  const ctx = await getCtx();
  await go(() => clearScheduledChange(getDb(), ctx), "Scheduled plan change removed.");
}
export async function applyCouponAction(fd: FormData) {
  const ctx = await getCtx();
  await go(async () => {
    const c = await applyCouponCode(getDb(), ctx, str(fd.get("code")));
    return `Coupon ${c.code} applied to your next ${c.months} invoice${c.months === 1 ? "" : "s"}.`;
  }, "Coupon applied.");
}
