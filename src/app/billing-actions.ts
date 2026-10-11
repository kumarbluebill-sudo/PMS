"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { AppError, toSafeError } from "@/server/errors";
import { rupeesToMinor } from "@/server/money";
import { openFolio, postCharge, postDiscount, postRoomNights } from "@/server/services/billing";
import { approveShift, closeShift, openShift, recordPayment, refundPayment } from "@/server/services/payments";
import { issueCreditNote, issueDebitNote, issueInvoice } from "@/server/services/invoicing";
import { createCompanyFolio, transferEntries } from "@/server/services/folios";
import { settleAndCheckOut } from "@/server/services/checkout";
import { approveRule, createRule, deleteDraftRule, retireRule, updateGstSettings } from "@/server/services/tax";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

async function run(back: string, fn: () => Promise<unknown>, ok?: string) {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  const sep = back.includes("?") ? "&" : "?";
  redirect(error ? `${back}${sep}error=${encodeURIComponent(error)}` : ok ? `${back}${sep}ok=${encodeURIComponent(ok)}` : back);
}

const folioBack = (fd: FormData) => `/app/guest-folios/${encodeURIComponent(str(fd.get("folioId")))}`;

export async function openFolioAction(fd: FormData) {
  const ctx = await getCtx();
  let id: string | null = null;
  let error: string | null = null;
  try {
    id = (await openFolio(getDb(), ctx, str(fd.get("reservationId")))).id;
  } catch (e) {
    error = toSafeError(e).message;
  }
  redirect(id ? `/app/guest-folios/${id}` : `/app/front-desk?error=${encodeURIComponent(error ?? "Could not open folio")}`);
}

export async function postChargeAction(fd: FormData) {
  const ctx = await getCtx();
  await run(folioBack(fd), () => {
    // The form asks for a rate per unit; the ledger stores the total, so the multiplication happens here, in whole paise.
    const quantity = Number(str(fd.get("quantity")) || 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw new AppError("VALIDATION", "Quantity must be a whole number from 1 to 10,000.");
    return postCharge(getDb(), ctx, str(fd.get("folioId")), {
      category: str(fd.get("category")),
      description: str(fd.get("description")),
      amountMinor: rupeesToMinor(str(fd.get("amount"))) * quantity,
      taxInclusive: fd.get("taxInclusive") === "on",
      quantity,
      serviceDate: str(fd.get("serviceDate")) || undefined,
      idempotencyKey: str(fd.get("key")),
    });
  }, "Charge posted.");
}

export async function createCompanyFolioAction(fd: FormData) {
  const ctx = await getCtx();
  let id: string | null = null;
  let error: string | null = null;
  try {
    id = (await createCompanyFolio(getDb(), ctx, str(fd.get("reservationId")), { billTo: str(fd.get("billTo")) })).id;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(id ? `/app/guest-folios/${id}?ok=Company%20folio%20ready.` : `${folioBack(fd)}?error=${encodeURIComponent(error ?? "Failed")}`);
}

export async function transferEntriesAction(fd: FormData) {
  const ctx = await getCtx();
  const entryIds = fd.getAll("entryIds").map(String).filter(Boolean);
  await run(
    folioBack(fd),
    () => transferEntries(getDb(), ctx, str(fd.get("folioId")), str(fd.get("toFolioId")), entryIds, str(fd.get("reason"))),
    "Charges moved.",
  );
}

export async function debitNoteAction(fd: FormData) {
  const ctx = await getCtx();
  const invoiceId = str(fd.get("invoiceId"));
  let id: string | null = null;
  let error: string | null = null;
  try {
    const quantity = Number(str(fd.get("quantity")) || 1);
    const dn = await issueDebitNote(getDb(), ctx, invoiceId, {
      reason: str(fd.get("reason")),
      lines: [{
        category: str(fd.get("category")), description: str(fd.get("description")),
        amountMinor: rupeesToMinor(str(fd.get("amount"))) * (Number.isInteger(quantity) && quantity > 0 ? quantity : 1),
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1, taxInclusive: fd.get("taxInclusive") === "on",
      }],
    });
    id = dn.id;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(id ? `/app/invoices/${id}` : `/app/invoices/${invoiceId}?error=${encodeURIComponent(error ?? "Failed")}`);
}

export async function settleCheckoutAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("reservationId"));
  const back = `/app/reservations/${encodeURIComponent(id)}/checkout`;
  let dest: string | null = null;
  let error: string | null = null;
  try {
    const amt = str(fd.get("amount")).trim();
    const exceptionKind = str(fd.get("exceptionKind"));
    const name = str(fd.get("recipientName")).trim();
    const r = await settleAndCheckOut(getDb(), ctx, id, {
      ...(amt ? { payment: { method: str(fd.get("method")), amountMinor: rupeesToMinor(amt), reference: str(fd.get("reference")) || undefined, idempotencyKey: str(fd.get("key")) } } : {}),
      ...(exceptionKind ? { exception: { kind: exceptionKind, reason: str(fd.get("exceptionReason")), company: str(fd.get("company")) || undefined } } : {}),
      issueInvoice: fd.get("issueInvoice") === "on",
      ...(name ? { recipient: { name, gstin: str(fd.get("recipientGstin")) || undefined, address: str(fd.get("recipientAddress")) || undefined } } : {}),
    });
    dest = r.invoiceId ? `/app/invoices/${r.invoiceId}` : "/app/dashboard";
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(dest ?? `${back}?error=${encodeURIComponent(error ?? "Failed")}`);
}

export async function postDiscountAction(fd: FormData) {
  const ctx = await getCtx();
  await run(folioBack(fd), () =>
    postDiscount(
      getDb(), ctx, str(fd.get("folioId")),
      { category: str(fd.get("category")), description: str(fd.get("description")), amountMinor: rupeesToMinor(str(fd.get("amount"))), taxInclusive: fd.get("taxInclusive") === "on" },
      str(fd.get("reason")),
    ),
  );
}

export async function postRoomNightsAction(fd: FormData) {
  const ctx = await getCtx();
  const back = str(fd.get("back"));
  const target = /^\/app\/reservations\/[\w-]+\/checkout$/.test(back) ? back : folioBack(fd);
  await run(target, () => postRoomNights(getDb(), ctx, str(fd.get("reservationId"))), "Room charges posted.");
}

export async function recordPaymentAction(fd: FormData) {
  const ctx = await getCtx();
  await run(
    folioBack(fd),
    () =>
      recordPayment(getDb(), ctx, str(fd.get("folioId")), {
        method: str(fd.get("method")),
        amountMinor: rupeesToMinor(str(fd.get("amount"))),
        reference: str(fd.get("reference")) || undefined,
        idempotencyKey: str(fd.get("key")),
      }),
    "Payment recorded.",
  );
}

export async function refundAction(fd: FormData) {
  const ctx = await getCtx();
  await run(
    folioBack(fd),
    () =>
      refundPayment(getDb(), ctx, str(fd.get("folioId")), {
        method: str(fd.get("method")) as "CASH",
        amountMinor: rupeesToMinor(str(fd.get("amount"))),
        reason: str(fd.get("reason")),
      }),
    "Refund recorded.",
  );
}

export async function issueInvoiceAction(fd: FormData) {
  const ctx = await getCtx();
  let invoiceId: string | null = null;
  let error: string | null = null;
  const name = str(fd.get("recipientName")).trim();
  try {
    const inv = await issueInvoice(getDb(), ctx, str(fd.get("folioId")), {
      entryIds: fd.getAll("entryIds").map(String).filter(Boolean).length ? fd.getAll("entryIds").map(String) : undefined,
      recipient: name ? { name, gstin: str(fd.get("recipientGstin")) || undefined, address: str(fd.get("recipientAddress")) || undefined } : undefined,
    });
    invoiceId = inv.id;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(invoiceId ? `/app/invoices/${invoiceId}` : `${folioBack(fd)}?error=${encodeURIComponent(error ?? "Failed")}`);
}

export async function creditNoteAction(fd: FormData) {
  const ctx = await getCtx();
  const invoiceId = str(fd.get("invoiceId"));
  let id: string | null = null;
  let error: string | null = null;
  try {
    const lines = fd.getAll("lineEntryIds").map(String).filter(Boolean);
    const cn = await issueCreditNote(getDb(), ctx, invoiceId, { reason: str(fd.get("reason")), lineEntryIds: lines.length ? lines : undefined });
    id = cn.id;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(id ? `/app/invoices/${id}` : `/app/invoices/${invoiceId}?error=${encodeURIComponent(error ?? "Failed")}`);
}

export async function openShiftAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/cashier", () => openShift(getDb(), ctx, rupeesToMinor(str(fd.get("opening")) || "0")), "Shift opened.");
}

export async function closeShiftAction(fd: FormData) {
  const ctx = await getCtx();
  await run(
    "/app/cashier",
    () => closeShift(getDb(), ctx, { countedMinor: rupeesToMinor(str(fd.get("counted"))), varianceReason: str(fd.get("varianceReason")) || undefined }),
    "Shift closed.",
  );
}

export async function approveShiftAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/cashier", () => approveShift(getDb(), ctx, str(fd.get("shiftId"))), "Shift approved.");
}

export async function createRuleAction(fd: FormData) {
  const ctx = await getCtx();
  const opt = (k: string) => (str(fd.get(k)).trim() === "" ? undefined : str(fd.get(k)).trim());
  await run(
    "/app/settings/tax",
    () =>
      createRule(getDb(), ctx, {
        category: str(fd.get("category")),
        sacCode: opt("sacCode"),
        description: str(fd.get("description")),
        treatment: str(fd.get("treatment")),
        ratePercent: Number(str(fd.get("ratePercent")) || 0),
        cessPercent: Number(str(fd.get("cessPercent")) || 0),
        tariffMinMinor: opt("tariffMin") ? rupeesToMinor(opt("tariffMin")!) : undefined,
        tariffMaxMinor: opt("tariffMax") ? rupeesToMinor(opt("tariffMax")!) : undefined,
        placeOfSupply: str(fd.get("placeOfSupply")) || "PROPERTY_STATE",
        effectiveFrom: str(fd.get("effectiveFrom")),
        effectiveTo: opt("effectiveTo"),
        legalRef: opt("legalRef"),
      }),
    "Draft rule saved. It has no effect until a different authorised user approves it.",
  );
}

export async function approveRuleAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/settings/tax", () => approveRule(getDb(), ctx, str(fd.get("ruleId"))), "Rule approved.");
}

export async function retireRuleAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/settings/tax", () => retireRule(getDb(), ctx, str(fd.get("ruleId")), str(fd.get("reason"))), "Rule retired.");
}

export async function deleteRuleAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/settings/tax", () => deleteDraftRule(getDb(), ctx, str(fd.get("ruleId"))), "Draft deleted.");
}

export async function gstSettingsAction(fd: FormData) {
  const ctx = await getCtx();
  await run(
    "/app/settings/tax",
    () =>
      updateGstSettings(
        getDb(), ctx,
        {
          gstRegistered: fd.get("gstRegistered") === "on",
          gstin: str(fd.get("gstin")) || undefined,
          legalName: str(fd.get("legalName")) || undefined,
          address: str(fd.get("address")) || undefined,
          invoicePrefix: str(fd.get("invoicePrefix")) || "INV",
        },
        str(fd.get("reason")),
      ),
    "GST settings saved.",
  );
}
