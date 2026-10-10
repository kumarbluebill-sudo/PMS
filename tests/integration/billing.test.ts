import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { loadContext, type Ctx } from "@/server/auth/context";
import type { RoleKey } from "@/server/auth/permissions";
import { gstinCheckChar } from "@/server/domain/gst";
import { registerTenant } from "@/server/services/tenant";
import { acceptInvite, inviteMember } from "@/server/services/accounts";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { checkIn, checkOut, createReservation } from "@/server/services/reservations";
import { folioDetail, openFolio, postCharge, postDiscount, postRoomNights } from "@/server/services/billing";
import { closeShift, approveShift, openShift, recordPayment, refundPayment } from "@/server/services/payments";
import { approveRule, createRule, retireRule, updateGstSettings } from "@/server/services/tax";
import { getInvoice, issueCreditNote, issueInvoice, previewInvoice } from "@/server/services/invoicing";
import { reconcile, trialBalance } from "@/server/services/accounting";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx, accounts: Ctx, cashier: Ctx, cashier2: Ctx, desk: Ctx;
let folioId: string, reservationId: string;

const GSTIN = (() => {
  const f = "33ABCDE1234F1Z";
  return f + gstinCheckChar(f);
})();

async function member(ctx: Ctx, role: RoleKey, tag: string): Promise<Ctx> {
  const email = `${tag}-${sfx}@test.local`;
  await inviteMember(app, ctx, { email, role, propertyIds: [ctx.propertyId!] });
  const m = await app.emailOutbox.findFirstOrThrow({ where: { toEmail: email } });
  const { userId } = await acceptInvite(app, /token=([\w-]+)/.exec(m.body)![1], { name: tag, password: "member-password-1" });
  return loadContext(app, { userId, epoch: 0 });
}
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// Arbitrary FIXTURE rates for exercising the engine; not tax advice.
const rule = (o: object) => ({
  category: "ROOM", description: "fixture", treatment: "TAXABLE", ratePercent: 12, effectiveFrom: "2020-01-01",
  legalRef: "test fixture", ...o,
});

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  const r = await registerTenant(app, {
    businessName: "Bill Co", propertyName: "Bill Inn", name: "Owner", email: `bill-owner-${sfx}@test.local`, password: "correct-horse-battery",
  });
  owner = await loadContext(app, { userId: r.userId, epoch: 0 });
  accounts = await member(owner, "ACCOUNTS_MANAGER", "acct");
  cashier = await member(owner, "CASHIER", "cash1");
  cashier2 = await member(owner, "CASHIER", "cash2");
  desk = await member(owner, "FRONT_DESK", "desk");

  const rt = await createRoomType(app, owner, { name: "Deluxe", baseRateMinor: 200000 });
  await createRoom(app, owner, { roomTypeId: rt.id, number: "101" });
  const g = await createGuest(app, owner, { name: "Bill Guest" });
  const res = await createReservation(app, owner, { guestId: g.id, roomTypeId: rt.id, arrival: "2035-03-10", departure: "2035-03-12" });
  reservationId = res.id;
  folioId = (await openFolio(app, owner, reservationId)).id;
  await checkIn(app, owner, reservationId);
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("GST configuration", () => {
  it("rejects an invalid GSTIN and requires a reason", async () => {
    const base = { gstRegistered: true, gstin: GSTIN, legalName: "Bill Co Pvt Ltd", address: "1 Beach Road, Chennai", invoicePrefix: "BI" };
    await expect(updateGstSettings(app, owner, { ...base, gstin: "33ABCDE1234F1ZX" }, "setup")).rejects.toThrow(/check digit/i);
    await expect(updateGstSettings(app, owner, base, " ")).rejects.toThrow(/reason/i);
    await updateGstSettings(app, owner, base, "Initial registration");
    const logs = await app.auditLog.findMany({ where: { tenantId: owner.tenantId, action: "tax.gst_settings" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].reason).toBe("Initial registration");
  });
  it("front desk cannot change GST settings", async () => {
    await expect(updateGstSettings(app, desk, { gstRegistered: false, invoicePrefix: "XX" }, "x")).rejects.toThrow(/permission/i);
  });
});

describe("tax rules: maker-checker and immutability", () => {
  it("refuses to charge when a registered property has no approved rule", async () => {
    await expect(postRoomNights(app, owner, reservationId)).rejects.toThrow(/No approved tax rule/);
  });
  it("creator cannot approve their own rule; another authorised user can", async () => {
    const draft = await createRule(app, owner, rule({ category: "ROOM", sacCode: "996311", ratePercent: 12 }));
    expect(draft.status).toBe("DRAFT");
    expect(draft.rateBp).toBe(1200);
    await expect(approveRule(app, owner, draft.id)).rejects.toThrow(/different authorised user/);
    await expect(approveRule(app, desk, draft.id)).rejects.toThrow(/permission/i);
    const ok = await approveRule(app, accounts, draft.id);
    expect(ok.status).toBe("APPROVED");
  });
  it("approved rules cannot be altered in the database; overlapping approval is refused", async () => {
    const [approved] = await admin.taxRule.findMany({ where: { tenantId: owner.tenantId, status: "APPROVED" } });
    await expect(admin.taxRule.update({ where: { id: approved.id }, data: { rateBp: 1 } })).rejects.toThrow(/immutable/);
    await expect(admin.taxRule.delete({ where: { id: approved.id } })).rejects.toThrow();
    const dup = await createRule(app, owner, rule({ category: "ROOM", ratePercent: 18 }));
    await expect(approveRule(app, accounts, dup.id)).rejects.toThrow(/overlaps/);
  });
  it("adds FNB (5% inclusive-capable) and retiring works with a reason", async () => {
    const fnb = await createRule(app, owner, rule({ category: "FNB", sacCode: "996331", ratePercent: 5 }));
    await approveRule(app, accounts, fnb.id);
    const tmp = await createRule(app, owner, rule({ category: "LAUNDRY", ratePercent: 18 }));
    const ap = await approveRule(app, accounts, tmp.id);
    await expect(retireRule(app, accounts, ap.id, " ")).rejects.toThrow(/reason/i);
    expect((await retireRule(app, accounts, ap.id, "superseded")).status).toBe("RETIRED");
  });
});

describe("charges, discounts and the folio ledger", () => {
  it("posts nightly room charges once, with a stored tax breakdown", async () => {
    const first = await postRoomNights(app, owner, reservationId);
    expect(first.posted).toBe(2);
    expect((await postRoomNights(app, owner, reservationId)).posted).toBe(0);
    const d = await folioDetail(app, owner, folioId);
    const rooms = d.folio.entries.filter((e) => e.category === "ROOM");
    expect(rooms).toHaveLength(2);
    for (const e of rooms) {
      expect(e).toMatchObject({ netMinor: 200000, taxMinor: 24000, balanceDeltaMinor: 224000 });
      expect(e.taxDetail).toMatchObject({ cgstMinor: 12000, sgstMinor: 12000, igstMinor: 0, ruleVersion: 1, supplyType: "INTRA_STATE" });
    }
    expect(d.balance).toBe(448000);
  });
  it("posts a tax-inclusive F&B charge with gross fixed", async () => {
    const e = await postCharge(app, desk, folioId, { category: "FNB", description: "Dinner", amountMinor: 105000, taxInclusive: true, idempotencyKey: key() });
    expect(e.balanceDeltaMinor).toBe(105000);
    expect(e.netMinor + e.taxMinor).toBe(105000);
    expect(e.netMinor).toBe(100000);
  });
  it("is idempotent on the charge key", async () => {
    const k = key();
    const before = (await folioDetail(app, owner, folioId)).folio.entries.length;
    const a = await postCharge(app, desk, folioId, { category: "FNB", description: "Coffee", amountMinor: 10000, idempotencyKey: k });
    const b = await postCharge(app, desk, folioId, { category: "FNB", description: "Coffee", amountMinor: 10000, idempotencyKey: k });
    expect(b.id).toBe(a.id);
    expect((await folioDetail(app, owner, folioId)).folio.entries.length).toBe(before + 1);
  });
  it("refuses to guess a rate: a category with no approved rule cannot be charged", async () => {
    await expect(
      postCharge(app, desk, folioId, { category: "OTHER", description: "Newspaper", amountMinor: 1000, idempotencyKey: key() }),
    ).rejects.toThrow(/No approved tax rule/);
  });
  it("discounts need permission, a reason, and cannot exceed the category total", async () => {
    await expect(postDiscount(app, desk, folioId, { category: "ROOM", description: "Loyalty", amountMinor: 1000 }, "loyal")).rejects.toThrow(/permission/i);
    await expect(postDiscount(app, accounts, folioId, { category: "ROOM", description: "Loyalty", amountMinor: 1000 }, " ")).rejects.toThrow(/reason/i);
    await expect(postDiscount(app, accounts, folioId, { category: "ROOM", description: "Too much", amountMinor: 999999 }, "x")).rejects.toThrow(/cannot exceed/);
    const dsc = await postDiscount(app, accounts, folioId, { category: "ROOM", description: "Loyalty 10%", amountMinor: 20000 }, "Loyalty member");
    expect(dsc).toMatchObject({ kind: "DISCOUNT", netMinor: -20000, taxMinor: -2400, balanceDeltaMinor: -22400 });
  });
  it("the ledger rejects edits and deletes", async () => {
    const e = await admin.folioEntry.findFirstOrThrow({ where: { folioId } });
    await expect(admin.folioEntry.update({ where: { id: e.id }, data: { netMinor: 1 } })).rejects.toThrow(/append-only/);
    await expect(admin.folioEntry.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
  });
});

describe("payments, shifts and checkout", () => {
  let balance: number;
  it("blocks checkout while a balance is outstanding; waiving needs permission and a reason", async () => {
    balance = (await folioDetail(app, owner, folioId)).balance;
    expect(balance).toBeGreaterThan(0);
    await expect(checkOut(app, desk, reservationId)).rejects.toThrow(/outstanding balance/i);
    await expect(checkOut(app, desk, reservationId, { waiveReason: "VIP" })).rejects.toThrow(/permission/i);
  });
  it("cash needs an open shift", async () => {
    await expect(recordPayment(app, cashier, folioId, { method: "CASH", amountMinor: 100000, idempotencyKey: key() })).rejects.toThrow(/open a cash shift/i);
  });
  it("duplicate deliveries of one payment key post exactly once", async () => {
    await openShift(app, cashier, 500000);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => recordPayment(app, cashier, folioId, { method: "CASH", amountMinor: 100000, idempotencyKey: k })),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await admin.payment.count({ where: { folioId } })).toBe(1);
    expect((await folioDetail(app, owner, folioId)).balance).toBe(balance - 100000);
    await expect(recordPayment(app, cashier, folioId, { method: "CASH", amountMinor: 5, idempotencyKey: k })).rejects.toThrow(/different payment/);
  });
  it("shift reconciliation: expected cash, variance reason, separate approver", async () => {
    await recordPayment(app, cashier, folioId, { method: "UPI", amountMinor: 50000, reference: "UPI123", idempotencyKey: key() });
    await expect(closeShift(app, cashier, { countedMinor: 590000 })).rejects.toThrow(/variance/i); // expected 600000
    const closed = await closeShift(app, cashier, { countedMinor: 590000, varianceReason: "Short change given" });
    expect(closed).toMatchObject({ expectedMinor: 600000, varianceMinor: -10000, status: "CLOSED" });
    expect(closed.totals).toMatchObject({ CASH: 100000, UPI: 50000 });
    await expect(approveShift(app, cashier, closed.id)).rejects.toThrow(/permission/i);
    await expect(approveShift(app, { ...accounts, userId: cashier.userId }, closed.id)).rejects.toThrow(/different supervisor/i);
    expect((await approveShift(app, accounts, closed.id)).approvedBy).toBe(accounts.userId);
  });
  it("settles the rest by bank transfer and checks out", async () => {
    const rest = (await folioDetail(app, owner, folioId)).balance;
    await recordPayment(app, cashier2, folioId, { method: "BANK_TRANSFER", amountMinor: rest, idempotencyKey: key() });
    const d = await folioDetail(app, owner, folioId);
    expect(d.balance).toBe(0);
    expect(d.paymentStatus).toBe("PAID");
    await expect(checkOut(app, desk, reservationId)).resolves.toMatchObject({ status: "CHECKED_OUT" });
  });
});

describe("invoices and credit notes", () => {
  let invoiceId: string, invoiceNumber: string, lineEntryIds: string[];
  it("previews from the ledger and issues a numbered tax invoice with matching totals", async () => {
    const prev = await previewInvoice(app, desk, folioId);
    expect(prev.kind).toBe("TAX_INVOICE");
    const inv = await issueInvoice(app, desk, folioId);
    invoiceId = inv.id;
    invoiceNumber = inv.number;
    expect(inv.number).toMatch(/^BI\/\d{4}\/000001$/);
    expect(inv.number.length).toBeLessThanOrEqual(16);
    expect(inv).toMatchObject({ kind: "TAX_INVOICE", netMinor: prev.totals.net, grossMinor: prev.totals.gross, cgstMinor: prev.totals.cgst });
    const full = await getInvoice(app, desk, inv.id);
    expect(full.lines.reduce((s, l) => s + l.grossMinor, 0)).toBe(inv.grossMinor);
    expect(inv.netMinor + inv.cgstMinor + inv.sgstMinor + inv.igstMinor + inv.cessMinor).toBe(inv.grossMinor);
    expect(full.supplier).toMatchObject({ gstin: GSTIN, stateCode: "33", registered: true });
    lineEntryIds = full.lines.map((l) => l.folioEntryId);
    await expect(issueInvoice(app, desk, folioId)).rejects.toThrow(/no uninvoiced/i);
  });
  it("issued invoices are immutable at the database level", async () => {
    await expect(admin.invoice.update({ where: { id: invoiceId }, data: { grossMinor: 1 } })).rejects.toThrow(/append-only/);
    await expect(admin.invoiceLine.delete({ where: { folioEntryId: lineEntryIds[0] } })).rejects.toThrow(/append-only/);
  });
  it("concurrent issuance of the same charges yields one invoice and gapless numbers", async () => {
    const c1 = await postCharge(app, desk, folioId, { category: "FNB", description: "Breakfast A", amountMinor: 30000, idempotencyKey: key() });
    const c2 = await postCharge(app, desk, folioId, { category: "FNB", description: "Breakfast B", amountMinor: 30000, idempotencyKey: key() });
    // The folio is closed by checkout? It stays OPEN; both charges are uninvoiced.
    const settled = await Promise.allSettled([
      issueInvoice(app, desk, folioId, { entryIds: [c1.id, c2.id] }),
      issueInvoice(app, desk, folioId, { entryIds: [c1.id, c2.id] }),
      issueInvoice(app, desk, folioId, { entryIds: [c1.id] }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ number: string }>[];
    expect(ok.length).toBe(1);
    const seqs = (await admin.invoice.findMany({ where: { tenantId: owner.tenantId, kind: "TAX_INVOICE" }, orderBy: { seq: "asc" } })).map((i) => i.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1..n with no gaps
    const lines = await admin.invoiceLine.findMany({ where: { folioEntryId: { in: [c1.id, c2.id] } } });
    expect(new Set(lines.map((l) => l.folioEntryId)).size).toBe(lines.length); // no charge on two invoices
  });
  it("rejects recipients with a bad GSTIN", async () => {
    const c = await postCharge(app, desk, folioId, { category: "FNB", description: "Snack", amountMinor: 10000, idempotencyKey: key() });
    await expect(previewInvoice(app, desk, folioId, { entryIds: [c.id], recipient: { name: "Acme", gstin: "33ABCDE1234F1Z0" } })).rejects.toThrow(/check digit|GSTIN/i);
    const good = "27AAPFU0939F1ZV";
    const p = await previewInvoice(app, desk, folioId, { entryIds: [c.id], recipient: { name: "Acme Ltd", gstin: good } });
    expect(p.recipient).toMatchObject({ gstin: good, stateCode: "27" });
  });
  it("credit note reverses lines via the ledger, once, with its own series and a required reason", async () => {
    await expect(issueCreditNote(app, desk, invoiceId, { reason: "Billing error" })).rejects.toThrow(/permission/i);
    await expect(issueCreditNote(app, accounts, invoiceId, { reason: " " })).rejects.toThrow();
    const full = await getInvoice(app, accounts, invoiceId);
    const dinner = full.lines.find((l) => l.description === "Dinner")!;
    const before = (await folioDetail(app, owner, folioId)).balance;
    const cn = await issueCreditNote(app, accounts, invoiceId, { reason: "Dinner billed in error", lineEntryIds: [dinner.folioEntryId] });
    expect(cn.kind).toBe("CREDIT_NOTE");
    expect(cn.number).toMatch(/^BIC\/\d{4}\/000001$/);
    expect(cn.grossMinor).toBe(-dinner.grossMinor);
    expect(cn.originalInvoiceId).toBe(invoiceId);
    expect((await folioDetail(app, owner, folioId)).balance).toBe(before - dinner.grossMinor);
    await expect(issueCreditNote(app, accounts, invoiceId, { reason: "again", lineEntryIds: [dinner.folioEntryId] })).rejects.toThrow(/already been credited/);
    // the original invoice document is unchanged
    expect((await getInvoice(app, accounts, invoiceId)).grossMinor).toBe(full.grossMinor);
    expect(invoiceNumber).toBeTruthy();
  });
});

describe("refunds", () => {
  it("only authorised users, only up to what was paid, and only via a method that received money", async () => {
    await expect(refundPayment(app, desk, folioId, { method: "UPI", amountMinor: 1000, reason: "test" })).rejects.toThrow(/permission/i);
    await expect(refundPayment(app, accounts, folioId, { method: "UPI", amountMinor: 1000, reason: "x" })).rejects.toThrow();
    await expect(refundPayment(app, accounts, folioId, { method: "UPI", amountMinor: 99_999_999, reason: "too much" })).rejects.toThrow(/exceeds/);
    await expect(refundPayment(app, accounts, folioId, { method: "UPI", amountMinor: 60000, reason: "too much upi" })).rejects.toThrow(/Not enough was paid by UPI/);
    await expect(refundPayment(app, accounts, folioId, { method: "CASH", amountMinor: 1000, reason: "cash refund" })).rejects.toThrow(/cash shift/i);
    const r = await refundPayment(app, accounts, folioId, { method: "UPI", amountMinor: 10000, reason: "Goodwill after complaint" });
    expect(r.amountMinor).toBe(10000);
    const d = await folioDetail(app, owner, folioId);
    expect(d.refunded).toBe(10000);
    expect(["PARTIALLY_REFUNDED"]).toContain(d.paymentStatus);
  });
});

describe("accounting reconciliation", () => {
  it("journal balances, receivable equals folio balances, and revenue/tax tie to the ledger", async () => {
    const rec = await reconcile(app, owner);
    expect(rec).toMatchObject({ journalBalanced: true, receivableMatchesFolios: true, invoiceTotalsMatchLines: true });
    const tb = await trialBalance(app, owner);
    const bal = (code: string) => tb.rows.find((r) => r.code === code)!.balanceMinor;
    const entries = await admin.folioEntry.findMany({ where: { tenantId: owner.tenantId, kind: { in: ["CHARGE", "DISCOUNT", "REVERSAL"] } } });
    const sum = (f: (e: (typeof entries)[number]) => number) => entries.reduce((s, e) => s + f(e), 0);
    expect(bal("4000")).toBe(sum((e) => (e.category === "ROOM" ? e.netMinor : 0)));
    expect(bal("4100")).toBe(sum((e) => (e.category === "FNB" ? e.netMinor : 0)));
    const det = (e: (typeof entries)[number]) => e.taxDetail as { cgstMinor: number; sgstMinor: number };
    expect(bal("2100")).toBe(sum((e) => det(e).cgstMinor));
    expect(bal("2110")).toBe(sum((e) => det(e).sgstMinor));
    expect(bal("2100")).toBe(bal("2110"));
    // cash: shift took 100000 in, nothing paid out
    expect(bal("1010")).toBe(100000);
  });
  it("the database refuses an unbalanced journal entry", async () => {
    const acct = await admin.account.findFirstOrThrow({ where: { tenantId: owner.tenantId, code: "1010" } });
    await expect(
      withTenant(app, owner.tenantId, async (tx) => {
        const e = await tx.journalEntry.create({
          data: { tenantId: owner.tenantId, date: new Date(), memo: "bad", sourceType: "TEST", sourceId: key(), createdBy: owner.userId },
        });
        await tx.journalLine.create({ data: { tenantId: owner.tenantId, entryId: e.id, accountId: acct.id, debitMinor: 100 } });
      }),
    ).rejects.toThrow(/unbalanced/);
  });
});

describe("tenant isolation for billing", () => {
  it("another hotel cannot see or bill against this folio, rules, or invoices", async () => {
    const r = await registerTenant(app, {
      businessName: "Other Co", propertyName: "Other Inn", name: "Other", email: `bill-other-${sfx}@test.local`, password: "correct-horse-battery",
    });
    const other = await loadContext(app, { userId: r.userId, epoch: 0 });
    await expect(folioDetail(app, other, folioId)).rejects.toThrow(/not found/i);
    await expect(postCharge(app, other, folioId, { category: "FNB", description: "Sneaky", amountMinor: 1000 })).rejects.toThrow(/not found/i);
    await expect(issueInvoice(app, other, folioId)).rejects.toThrow(/not found/i);
    await expect(issueCreditNote(app, other, await invoiceIdOf(), { reason: "attack" })).rejects.toThrow(/not found/i);
    expect((await trialBalance(app, other)).rows.every((x) => x.debitMinor === 0 && x.creditMinor === 0)).toBe(true);

    // Unregistered property: no tax, bill of supply, its own numbering.
    const rt = await createRoomType(app, other, { name: "Std", baseRateMinor: 150000 });
    await createRoom(app, other, { roomTypeId: rt.id, number: "1" });
    const g = await createGuest(app, other, { name: "Unreg Guest" });
    const res = await createReservation(app, other, { guestId: g.id, roomTypeId: rt.id, arrival: "2035-04-01", departure: "2035-04-02" });
    const f = await openFolio(app, other, res.id);
    await postRoomNights(app, other, res.id);
    const inv = await issueInvoice(app, other, f.id);
    expect(inv).toMatchObject({ kind: "BILL_OF_SUPPLY", cgstMinor: 0, grossMinor: 150000 });
    expect(inv.number).toMatch(/^INVB\/\d{4}\/000001$/);
  });
});

async function invoiceIdOf() {
  return (await admin.invoice.findFirstOrThrow({ where: { kind: "TAX_INVOICE", tenantId: owner.tenantId } })).id;
}
