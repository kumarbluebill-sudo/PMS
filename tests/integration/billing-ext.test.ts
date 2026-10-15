import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { gstinCheckChar } from "@/server/domain/gst";
import { renderInvoicePdf } from "@/server/pdf/invoice";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createBooking } from "@/server/services/booking";
import { checkIn } from "@/server/services/reservations";
import { folioDetail, openFolio, postCharge, postRoomNights } from "@/server/services/billing";
import { approveRule, createRule, updateGstSettings } from "@/server/services/tax";
import { getInvoice, recordInvoicePrint, issueCreditNote, issueDebitNote, issueInvoice } from "@/server/services/invoicing";
import { recordPayment, refundPayment, getPaymentReceipt } from "@/server/services/payments";
import { createCompanyFolio, transferEntries } from "@/server/services/folios";
import { checkoutOverview, settleAndCheckOut } from "@/server/services/checkout";
import { gstSummary } from "@/server/services/gstReports";
import { reconcile, trialBalance } from "@/server/services/accounting";
import { roomBoard } from "@/server/services/dashboard";
import { csvCell, toCsv } from "@/server/csv";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let deluxe: string;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asRole = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
let n = 0;

/** An in-house stay arriving today for 2 nights. */
async function stay(opts: { adults?: number; children?: number; advance?: number } = {}) {
  // Earlier tests leave checked-out rooms dirty; housekeeping would clean them.
  await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "CLEAN" } });
  const r = await createBooking(app, owner, {
    newGuest: { name: `Bill Guest ${++n}`, mobile: `9222${String(100000 + n)}` }, roomTypeId: deluxe, arrival: today, departure: addDays(today, 2),
    adults: opts.adults ?? 2, children: opts.children ?? 0, ...(opts.advance ? { advance: { amountMinor: opts.advance, method: "UPI" } } : {}),
  });
  const res = r.reservations[0];
  await checkIn(app, owner, res.id);
  const folio = await openFolio(app, owner, res.id);
  return { res, folioId: folio.id };
}

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  const mk = async (label: string) =>
    loadContext(app, {
      userId: (await registerTenant(app, { businessName: `B ${label}`, propertyName: `H ${label}`, name: "Owner", email: `bx-${label}-${sfx}@test.local`, password: "correct-horse-battery" })).userId,
      epoch: 0,
    });
  owner = await mk("a");
  other = await mk("b");
  today = (await roomBoard(app, owner)).today;
  const f = "33ABCDE1234F1Z";
  await updateGstSettings(app, owner, { gstRegistered: true, gstin: f + gstinCheckChar(f), legalName: "Ext Co Pvt Ltd", address: "1 Beach Road, Chennai", invoicePrefix: "EX" }, "setup");
  // Arbitrary FIXTURE rates, not tax advice.
  for (const [category, sacCode, ratePercent] of [["ROOM", "996311", 12], ["FNB", "996331", 5], ["OTHER", "999799", 18]] as const) {
    const draft = await createRule(app, owner, { category, sacCode, description: "fixture", treatment: "TAXABLE", ratePercent, effectiveFrom: "2020-01-01", legalRef: "test fixture" });
    await approveRule(app, asRole(owner, "ACCOUNTS_MANAGER"), draft.id);
  }
  deluxe = (await createRoomType(app, owner, { name: "Deluxe", maxAdults: 4, maxChildren: 2, baseRateMinor: 450_000, baseOccupancy: 2, extraAdultRateMinor: 100_000, extraChildRateMinor: 50_000 })).id;
  for (let i = 0; i < 14; i++) await createRoom(app, owner, { roomTypeId: deluxe, number: String(300 + i) });
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("extra-person charges and the billing summary", () => {
  it("posts an extra-person charge per night for guests beyond the base occupancy, once", async () => {
    const { res, folioId } = await stay({ adults: 3, children: 1 });
    const first = await postRoomNights(app, owner, res.id);
    expect(first.posted).toBe(4); // 2 nights x (room + extra)
    expect((await postRoomNights(app, owner, res.id)).posted).toBe(0);
    const entries = await admin.folioEntry.findMany({ where: { folioId, kind: "CHARGE" }, orderBy: { postedAt: "asc" } });
    const extra = entries.filter((e) => e.subCategory === "EXTRA_PERSON");
    expect(extra).toHaveLength(2);
    expect(extra[0]).toMatchObject({ category: "ROOM", netMinor: 150_000, taxMinor: 18_000 }); // 1 extra adult + 1 child, 12%
    const d = await folioDetail(app, owner, folioId);
    expect(d.summary).toMatchObject({ roomMinor: 900_000, extraPersonMinor: 300_000, taxMinor: 144_000, billedMinor: 1_344_000 });
    expect(d.balance).toBe(1_344_000);
  });

  it("charges nothing extra within the base occupancy", async () => {
    const { res, folioId } = await stay({ adults: 2 });
    await postRoomNights(app, owner, res.id);
    expect(await admin.folioEntry.count({ where: { folioId, subCategory: "EXTRA_PERSON" } })).toBe(0);
  });

  it("separates advances from later payments and keeps parts equal to the bill", async () => {
    const { res, folioId } = await stay({ advance: 200_000 });
    await postRoomNights(app, owner, res.id);
    await postCharge(app, owner, folioId, { category: "FNB", description: "Dinner", amountMinor: 100_000, idempotencyKey: key() });
    await recordPayment(app, owner, folioId, { method: "CARD", amountMinor: 300_000, idempotencyKey: key() });
    const { summary: s } = await folioDetail(app, owner, folioId);
    expect(s.advanceMinor).toBe(200_000); // paid before check-in
    expect(s.paymentsMinor).toBe(500_000);
    expect(s.restaurantMinor).toBe(100_000);
    expect(s.roomMinor + s.extraPersonMinor + s.restaurantMinor + s.otherServicesMinor - s.discountsMinor + s.taxMinor).toBe(s.billedMinor);
    expect(s.balanceMinor).toBe(s.billedMinor - 500_000);
  });
});

describe("charge posting", () => {
  it("validates the posting date and quantity", async () => {
    const { folioId } = await stay();
    const base = { category: "OTHER", description: "Laundry", amountMinor: 10_000 };
    await expect(postCharge(app, owner, folioId, { ...base, serviceDate: addDays(today, 1), idempotencyKey: key() })).rejects.toThrow(/between check-in and today/);
    await expect(postCharge(app, owner, folioId, { ...base, serviceDate: addDays(today, -1), idempotencyKey: key() })).rejects.toThrow(/between check-in and today/);
    const ok = await postCharge(app, owner, folioId, { ...base, serviceDate: today, quantity: 3, amountMinor: 30_000, idempotencyKey: key() });
    expect(ok).toMatchObject({ quantity: 3, netMinor: 30_000, taxMinor: 5_400 });
  });
});

describe("company folios and transfers", () => {
  it("moves charges to a company folio without losing history, tax or the ledger balance", async () => {
    const { res, folioId } = await stay();
    await postRoomNights(app, owner, res.id);
    await expect(createCompanyFolio(app, asRole(owner, "HOUSEKEEPING"), res.id, { billTo: "Acme Ltd" })).rejects.toThrow(/permission/i);
    const company = await createCompanyFolio(app, owner, res.id, { billTo: "Acme Ltd" });
    expect(company).toMatchObject({ label: "COMPANY", billTo: "Acme Ltd" });
    expect((await createCompanyFolio(app, owner, res.id, { billTo: "Acme Ltd" })).id).toBe(company.id);

    const charges = await admin.folioEntry.findMany({ where: { folioId, kind: "CHARGE" } });
    const before = (await folioDetail(app, owner, folioId)).balance;
    await expect(transferEntries(app, asRole(owner, "FRONT_DESK"), folioId, company.id, [charges[0].id], "company pays")).rejects.toThrow(/permission/i);
    await expect(transferEntries(app, owner, folioId, company.id, [charges[0].id], " ")).rejects.toThrow(/reason/i);
    await expect(transferEntries(app, owner, folioId, folioId, [charges[0].id], "same")).rejects.toThrow(/different folio/);
    await transferEntries(app, owner, folioId, company.id, charges.map((c) => c.id), "Company pays the stay");

    const guest = await folioDetail(app, owner, folioId);
    const co = await folioDetail(app, owner, company.id);
    expect(guest.balance).toBe(0);
    expect(co.balance).toBe(before);
    expect(co.folio.entries.map((e) => e.taxMinor).sort()).toEqual(charges.map((c) => c.taxMinor).sort());
    expect(guest.folio.entries.filter((e) => e.kind === "REVERSAL")).toHaveLength(charges.length);
    // The original charges are still on record, untouched.
    expect(await admin.folioEntry.count({ where: { id: { in: charges.map((c) => c.id) } } })).toBe(charges.length);
    // Moved charges cannot be moved or invoiced from the guest folio again.
    await expect(transferEntries(app, owner, folioId, company.id, [charges[0].id], "again")).rejects.toThrow(/already/);
    await expect(issueInvoice(app, owner, folioId)).rejects.toThrow(/no uninvoiced charges/i);
    // The company folio is invoiced to the company.
    const inv = await issueInvoice(app, owner, company.id);
    expect((inv.recipient as { name: string }).name).toBe("Acme Ltd");
    expect(inv.grossMinor).toBe(before);
    // Invoiced charges cannot be moved back.
    const moved = await admin.folioEntry.findMany({ where: { folioId: company.id, kind: "CHARGE" } });
    await expect(transferEntries(app, owner, company.id, folioId, [moved[0].id], "back")).rejects.toThrow(/already/);
    const rec = await reconcile(app, owner);
    expect(rec).toMatchObject({ journalBalanced: true, receivableMatchesFolios: true, invoiceTotalsMatchLines: true });
  });

  it("refuses transfers across reservations, and other tenants cannot reach the folios", async () => {
    const a = await stay();
    const b = await stay();
    await postRoomNights(app, owner, a.res.id);
    const co = await createCompanyFolio(app, owner, b.res.id, { billTo: "Other Co" });
    const entry = await admin.folioEntry.findFirstOrThrow({ where: { folioId: a.folioId, kind: "CHARGE" } });
    await expect(transferEntries(app, owner, a.folioId, co.id, [entry.id], "wrong")).rejects.toThrow(/same reservation/);
    await expect(createCompanyFolio(app, other, a.res.id, { billTo: "Spy" })).rejects.toThrow(/not found/i);
  });
});

describe("company credit payments", () => {
  it("needs a manager and a company name, posts to the company receivable and cannot be refunded", async () => {
    const { res, folioId } = await stay();
    await postRoomNights(app, owner, res.id);
    const amountMinor = 100_000;
    await expect(recordPayment(app, asRole(owner, "FRONT_DESK"), folioId, { method: "COMPANY_CREDIT", amountMinor, reference: "Acme", idempotencyKey: key() })).rejects.toThrow(/permission/i);
    await expect(recordPayment(app, owner, folioId, { method: "COMPANY_CREDIT", amountMinor, idempotencyKey: key() })).rejects.toThrow(/Name the company/);
    const before = (await trialBalance(app, owner)).rows.find((r) => r.code === "1110")?.balanceMinor ?? 0;
    await recordPayment(app, owner, folioId, { method: "COMPANY_CREDIT", amountMinor, reference: "Acme Ltd", idempotencyKey: key() });
    expect((await trialBalance(app, owner)).rows.find((r) => r.code === "1110")?.balanceMinor).toBe(before + amountMinor);
    await expect(refundPayment(app, owner, folioId, { method: "COMPANY_CREDIT" as "CASH", amountMinor: 100, reason: "no" })).rejects.toThrow();
    expect(await reconcile(app, owner)).toMatchObject({ journalBalanced: true, receivableMatchesFolios: true });
  });
});

describe("settle and check out", () => {
  it("refuses an unpaid balance and changes nothing", async () => {
    const { res, folioId } = await stay();
    const o = await checkoutOverview(app, owner, res.id);
    expect(o.unpostedNights).toBe(2);
    await expect(settleAndCheckOut(app, owner, res.id, {})).rejects.toThrow(/outstanding balance of ₹10080\.00/);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("CHECKED_IN");
    expect(await admin.invoice.count({ where: { folioId } })).toBe(0);
    // The whole checkout is one transaction, so a refusal leaves nothing behind, not even the posted nights.
    expect((await checkoutOverview(app, owner, res.id)).unpostedNights).toBe(2);
    expect(await admin.folioEntry.count({ where: { folioId, category: "ROOM" } })).toBe(0);
  });

  it("takes payment, issues the final invoice, checks out, and leaves the room dirty", async () => {
    const { res, folioId } = await stay({ adults: 3 });
    // 2 nights x (4,500 + 1,000 extra) = 11,000 + 12% GST = 12,320. Paying more than is owed is refused, and no payment is taken.
    await expect(settleAndCheckOut(app, owner, res.id, { payment: { method: "UPI", amountMinor: 1_344_000, reference: "UTR9", idempotencyKey: key() } })).rejects.toThrow(/more than the balance/);
    expect(await admin.payment.count({ where: { folioId } })).toBe(0);
    const ok = await settleAndCheckOut(app, owner, res.id, { payment: { method: "UPI", amountMinor: 1_232_000, reference: "UTR9", idempotencyKey: key() } });
    expect(ok.balanceMinor).toBe(0);
    const inv = await getInvoice(app, owner, ok.invoiceId!);
    expect(inv).toMatchObject({ kind: "TAX_INVOICE", grossMinor: 1_232_000 });
    expect(inv.number).toMatch(/^EX\/\d{4}\/\d{6}$/);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("CHECKED_OUT");
    const asg = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: res.id } });
    expect((await admin.room.findUniqueOrThrow({ where: { id: asg.roomId } })).housekeeping).toBe("DIRTY");
    expect((await folioDetail(app, owner, folioId)).balance).toBe(0);
    // Submitting the same checkout again changes nothing and takes no second payment.
    const again = await settleAndCheckOut(app, owner, res.id, { payment: { method: "UPI", amountMinor: 1_232_000, reference: "UTR9", idempotencyKey: key() } });
    expect(again.balanceMinor).toBe(0);
    expect(await admin.payment.count({ where: { folioId } })).toBe(1);
    expect(await admin.invoice.count({ where: { folioId } })).toBe(1);
  });

  it("the final invoice can be skipped", async () => {
    const { res } = await stay();
    const ok = await settleAndCheckOut(app, owner, res.id, { payment: { method: "CARD", amountMinor: 1_008_000, idempotencyKey: key() }, issueInvoice: false });
    expect(ok.invoiceId).toBeUndefined();
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("CHECKED_OUT");
  });

  it("company credit and approved-unpaid exceptions need manager authority and a reason", async () => {
    const a = await stay();
    const desk = asRole(owner, "FRONT_DESK");
    await expect(settleAndCheckOut(app, desk, a.res.id, { exception: { kind: "COMPANY_CREDIT", reason: "Acme pays", company: "Acme Ltd" } })).rejects.toThrow(/permission/i);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: a.res.id } })).status).toBe("CHECKED_IN");
    await expect(settleAndCheckOut(app, owner, a.res.id, { exception: { kind: "COMPANY_CREDIT", reason: "x" } })).rejects.toThrow(/reason/i);
    await expect(settleAndCheckOut(app, owner, a.res.id, { exception: { kind: "COMPANY_CREDIT", reason: "Acme pays the stay" } })).rejects.toThrow(/Name the company/);
    const done = await settleAndCheckOut(app, owner, a.res.id, { exception: { kind: "COMPANY_CREDIT", reason: "Acme pays the stay", company: "Acme Ltd" } });
    expect(done.balanceMinor).toBe(0);
    expect(await admin.payment.count({ where: { folioId: a.folioId, method: "COMPANY_CREDIT" } })).toBe(1);
    expect(await admin.auditLog.count({ where: { entityId: a.res.id, action: "checkout.company_credit" } })).toBe(1);

    const b = await stay();
    await settleAndCheckOut(app, owner, b.res.id, { exception: { kind: "APPROVED_UNPAID", reason: "Owner approved, pays Friday" } });
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: b.res.id } })).status).toBe("CHECKED_OUT");
    expect((await folioDetail(app, owner, b.folioId)).balance).toBe(1_008_000);
    expect(await admin.auditLog.count({ where: { entityId: b.res.id, action: "checkout.waive_balance" } })).toBe(1);
  });
});

describe("debit notes, credit notes and the GST summary", () => {
  it("issues a debit note in its own series, raising the balance and leaving the original untouched", async () => {
    const { res, folioId } = await stay();
    const paid = await settleAndCheckOut(app, owner, res.id, { payment: { method: "UPI", amountMinor: 1_008_000, idempotencyKey: key() } });
    const orig = await getInvoice(app, owner, paid.invoiceId!);
    await expect(issueDebitNote(app, asRole(owner, "FRONT_DESK"), orig.id, { reason: "minibar", lines: [{ category: "FNB", description: "Minibar", amountMinor: 20_000 }] })).rejects.toThrow(/permission/i);
    await expect(issueDebitNote(app, owner, orig.id, { reason: "minibar", lines: [] })).rejects.toThrow(/at least one/);
    const dn = await issueDebitNote(app, owner, orig.id, { reason: "Minibar consumption missed", lines: [{ category: "FNB", description: "Minibar", amountMinor: 20_000 }] });
    expect(dn).toMatchObject({ kind: "DEBIT_NOTE", originalInvoiceId: orig.id, netMinor: 20_000, cgstMinor: 500, sgstMinor: 500, grossMinor: 21_000 });
    expect(dn.number).toMatch(/^EXD\/\d{4}\/\d{6}$/);
    expect((await folioDetail(app, owner, folioId)).balance).toBe(21_000);
    expect(await getInvoice(app, owner, orig.id)).toMatchObject({ grossMinor: 1_008_000, number: orig.number });
    await expect(admin.invoice.update({ where: { id: dn.id }, data: { grossMinor: 1 } })).rejects.toThrow(/append-only/);
    const dnLine = await admin.invoiceLine.findFirstOrThrow({ where: { invoiceId: dn.id } });
    await expect(issueDebitNote(app, other, orig.id, { reason: "x1x", lines: [{ category: "FNB", description: "Spy", amountMinor: 1 }] })).rejects.toThrow(/not found/i);
    expect(dnLine.grossMinor).toBe(21_000);
    await issueCreditNote(app, owner, orig.id, { reason: "Goodwill gesture" });
  });

  it("the GST summary nets credit and debit notes and matches the register", async () => {
    const s = await gstSummary(app, owner, { from: today, to: today });
    expect(s.register.length).toBeGreaterThan(3);
    expect(s.register.some((r) => r.kind === "CREDIT_NOTE" && r.grossMinor < 0 && r.originalNumber)).toBe(true);
    expect(s.register.some((r) => r.kind === "DEBIT_NOTE" && r.grossMinor > 0)).toBe(true);
    const regTotal = (k: "taxableMinor" | "cgstMinor" | "grossMinor") => s.register.reduce((t, r) => t + r[k], 0);
    expect(s.totals.taxableMinor).toBe(regTotal("taxableMinor"));
    expect(s.totals.cgstMinor).toBe(regTotal("cgstMinor"));
    expect(s.totals.grossMinor).toBe(regTotal("grossMinor"));
    const room = s.rows.find((r) => r.sacCode === "996311" && r.rateBp === 1200);
    expect(room).toBeTruthy();
    expect(room!.cgstMinor).toBe(room!.sgstMinor);
    expect(room!.cgstMinor + room!.sgstMinor + room!.igstMinor).toBe(Math.round((room!.taxableMinor * 0.12) / 1) || room!.cgstMinor + room!.sgstMinor);
    expect((await gstSummary(app, owner, { from: addDays(today, 30), to: addDays(today, 31) })).register).toHaveLength(0);
    await expect(gstSummary(app, owner, { from: today, to: addDays(today, -1) })).rejects.toThrow(/end date/);
    await expect(gstSummary(app, asRole(owner, "FRONT_DESK"), { from: today, to: today })).rejects.toThrow(/permission/i);
    expect((await gstSummary(app, other, { from: today, to: today })).register).toHaveLength(0);
  });

  it("CSV cells cannot carry spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+91 98765")).toBe(`"'+91 98765"`);
    expect(csvCell("a,b\"c")).toBe(`"a,b""c"`);
    expect(toCsv(["h"], [[null], [5]])).toBe(`"h"\r\n""\r\n"5"`);
  });
});

describe("receipts and PDFs", () => {
  it("builds a receipt for a payment and keeps it tenant-private", async () => {
    const { res, folioId } = await stay();
    await postRoomNights(app, owner, res.id);
    const { payment } = await recordPayment(app, owner, folioId, { method: "UPI", amountMinor: 400_000, reference: "UTR-R", idempotencyKey: key() });
    const r = await getPaymentReceipt(app, owner, payment.id);
    expect(r).toMatchObject({ balanceAfterMinor: 1_008_000 - 400_000, receivedByName: "Owner" });
    expect(r.payment.reference).toBe("UTR-R");
    await expect(getPaymentReceipt(app, other, payment.id)).rejects.toThrow(/not found/i);
    await expect(getPaymentReceipt(app, asRole(owner, "HOUSEKEEPING"), payment.id)).rejects.toThrow(/permission/i);
  });

  it("renders an issued invoice to PDF from stored data", async () => {
    const { res, folioId } = await stay();
    await postRoomNights(app, owner, res.id);
    const issued = await issueInvoice(app, owner, folioId);
    const inv = await getInvoice(app, owner, issued.id);
    const bytes = await renderInvoicePdf({
      number: inv.number, kind: inv.kind, issuedDate: inv.issuedDate, supplier: inv.supplier as never, recipient: inv.recipient as never, placeOfSupply: inv.placeOfSupply,
      lines: inv.lines, totals: { netMinor: inv.netMinor, cgstMinor: inv.cgstMinor, sgstMinor: inv.sgstMinor, igstMinor: inv.igstMinor, cessMinor: inv.cessMinor, grossMinor: inv.grossMinor },
    });
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  });
});

describe("invoice copies and stay details", () => {
  it("labels the first print as the original and later ones as numbered duplicates, and carries the stay", async () => {
    const { res } = await stay();
    const paid = await settleAndCheckOut(app, owner, res.id, { payment: { method: "UPI", amountMinor: 1_008_000, idempotencyKey: key() } });
    const first = await recordInvoicePrint(app, owner, paid.invoiceId!);
    const second = await recordInvoicePrint(app, owner, paid.invoiceId!);
    expect(first).toEqual({ copy: 1, label: "ORIGINAL FOR RECIPIENT" });
    expect(second).toEqual({ copy: 2, label: "DUPLICATE COPY (2)" });
    expect(await admin.auditLog.count({ where: { entityId: paid.invoiceId!, action: "invoice.print" } })).toBe(2);
    const inv = await getInvoice(app, owner, paid.invoiceId!);
    expect(inv.stay).toMatchObject({ reference: res.reference, nights: 2 });
    expect(inv.stay?.room).toBeTruthy();
    await expect(recordInvoicePrint(app, asRole(owner, "HOUSEKEEPING"), paid.invoiceId!)).rejects.toThrow(/permission/i);
  });
});
