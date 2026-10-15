import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { generate } from "otplib";

const stamp = Date.now().toString(36);
const email = `e2e-${stamp}@test.local`;
const password = "e2e-password-123";


/** Fails on serious or critical WCAG A/AA problems on the page as currently shown (screens with real data). */
async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
  expect(bad, label).toEqual([]);
}

async function signIn(page: Page, code?: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  if (code) await page.getByLabel(/Authenticator code/).fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("owner registers, enrols MFA, runs a stay end to end, and it is audited", async ({ page }) => {
  // Unauthenticated access is redirected.
  await page.goto("/app/dashboard");
  await expect(page).toHaveURL(/\/login/);

  // Register -> forced to MFA setup (owner role requires it).
  await page.goto("/register");
  await page.getByLabel("Business name").fill(`E2E Hotels ${stamp}`);
  await page.getByLabel("First property name").fill("E2E Inn");
  await page.getByLabel("Your name").fill("E2E Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/security/);

  // Cannot reach tenant data before enrolling.
  await page.goto("/app/dashboard");
  await expect(page).toHaveURL(/\/security/);

  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Confirm and enable" }).click();
  await expect(page.getByText("MFA is enabled")).toBeVisible();

  // Onboarding checklist and property settings.
  await page.goto("/onboarding");
  await page.getByLabel("Address").fill("1 Beach Road, Goa");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Property saved.")).toBeVisible();

  // Room type + room.
  await page.goto("/app/room-types");
  await page.getByLabel("Name").fill("Deluxe");
  await page.getByLabel("Base rate (₹)").fill("4500");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Deluxe").first()).toBeVisible();

  await page.goto("/app/rooms");
  await page.getByLabel("Room number").fill("101");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("101")).toBeVisible();

  // Settings persist across a reload and are applied (invoice terms, a renamed room status).
  await page.goto("/app/settings/billing");
  await page.getByLabel("Invoice terms").fill("Payable on receipt (e2e)");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Invoice terms")).toHaveValue("Payable on receipt (e2e)");
  await page.goto("/app/settings/rooms");
  await page.locator('input[name="label_AVAILABLE"]').fill("Ready to sell");
  await page.getByRole("button", { name: "Save labels" }).click();
  await expect(page.getByText("Status labels saved.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/app/dashboard");
  await expect(page.getByRole("list", { name: "Room status legend" }).getByText("Ready to sell")).toBeVisible();

  // Guest + reservation starting today.
  await page.goto("/app/guests");
  await page.getByLabel("Name").fill("Asha Verma");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Asha Verma")).toBeVisible();

  // Reservation: check availability and price first, then save (the guest is picked from the list).
  const plus = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  await page.goto("/app/reservations/new");
  const arrival = await page.getByLabel("Check-in").inputValue(); // defaults to today at the property
  await page.getByLabel("Check-out").fill(plus(arrival, 2));
  await page.getByRole("button", { name: "Check availability and price" }).click();
  await expect(page.getByText("1 Deluxe room(s) available for 2 night(s).")).toBeVisible();
  await expect(page.getByText("₹9,000.00").first()).toBeVisible();
  await expectAccessible(page, "reservation form with quote");
  // Guest recognition: typing part of the name offers the existing profile; choosing it uses that profile.
  await page.getByLabel("Guest name").fill("Asha");
  await page.getByRole("option", { name: /Asha Verma/ }).click();
  await expect(page.getByText("existing guest. This booking uses their profile.")).toBeVisible();
  await page.getByLabel("Mobile number").fill("98765 43210");
  await page.getByRole("button", { name: "Save booking" }).click();
  await expect(page.getByRole("heading", { name: "Booking confirmation" })).toBeVisible();
  await expect(page.getByText(/MK-[0-9A-F]{8}/).first()).toBeVisible();
  await expect(page.getByText("Estimated total")).toBeVisible();
  await page.goto("/app/reservations");
  await expect(page.getByRole("cell", { name: "Asha Verma" })).toBeVisible();
  await page.goto("/app/reservations/new");

  // A second booking for the only room on overlapping dates is shown as unavailable before it can be saved.
  await page.getByLabel("Check-in").fill(plus(arrival, 1));
  await page.getByLabel("Check-out").fill(plus(arrival, 3));
  await page.getByRole("button", { name: "Check availability and price" }).click();
  await expect(page.getByText("No Deluxe room is available for those dates.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save booking" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Front desk: check in, then out.
  await page.goto("/app/front-desk");
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText("In house (1)")).toBeVisible();

  // The room board lists the room with its guest and a text status (not colour alone).
  await page.goto("/app/dashboard?view=table");
  const row101 = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "101" }) });
  await expect(row101.getByText("Occupied")).toBeVisible();
  await expect(row101.getByText("Asha Verma")).toBeVisible();
  await expectAccessible(page, "room board with data");
  await expect(page.getByRole("list", { name: "Room status legend" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/app/front-desk");

  // Check-out is refused while the folio has an unpaid balance (2 nights x Rs 4,500, unregistered so no GST).
  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByText(/outstanding balance of ₹9000\.00/)).toBeVisible();

  // Open the folio, post room charges, take a UPI payment for the full balance.
  await page.getByRole("button", { name: "Folio" }).click();
  await page.getByRole("button", { name: "Post room-night charges" }).click();
  await expect(page.getByText("Room charges posted.")).toBeVisible();
  await expect(page.getByText("₹9,000.00").first()).toBeVisible();
  const payForm = page.locator("form", { has: page.getByRole("button", { name: "Record payment" }) });
  await payForm.getByLabel("Method").selectOption("UPI");
  await payForm.getByLabel(/Reference/).fill("UTR-E2E-1");
  await payForm.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  await expect(page.getByText("Balance due").locator("xpath=following-sibling::div")).toHaveText("₹0.00");

  // Issue the invoice: property is not GST-registered, so it is a Bill of Supply with no tax.
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("heading", { name: "Bill of Supply" })).toBeVisible();
  await expect(page.getByText(/INVB\/\d{4}\/000001/).first()).toBeVisible();
  await expect(page.getByText("No GST has been charged on this document.")).toBeVisible();
  await expect(page.getByText("Payable on receipt (e2e)")).toBeVisible();
  await expectAccessible(page, "invoice");
  // The same document downloads as a real PDF.
  const pdfHref = await page.getByRole("link", { name: "Download PDF" }).getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Check-out through the settlement page: balance is clear and the invoice is already issued.
  await page.goto("/app/front-desk");
  await page.getByRole("link", { name: "Settle & check out" }).first().click();
  await expect(page.getByRole("heading", { name: "Check-out: Asha Verma" })).toBeVisible();
  await expect(page.getByText("Balance due").first()).toBeVisible();
  await page.getByLabel(/I confirm the guest has left/).check();
  await page.getByRole("button", { name: "Complete check-out" }).click();
  await expect(page).toHaveURL(/\/checkout\/done/);
  await expect(page.getByRole("heading", { name: "Check-out complete" })).toBeVisible();
  await expect(page.getByText("Housekeeping has been notified.")).toBeVisible();
  await page.goto("/app/front-desk");
  await expect(page.getByText("In house (0)")).toBeVisible();

  // Housekeeping shows the room dirty after checkout.
  await page.goto("/app/housekeeping");
  await expect(page.getByRole("table").getByText("Vacant – Dirty").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Awaiting cleaning/ })).toBeVisible();
  await expectAccessible(page, "housekeeping board");
  // The cleaning cycle: start, then mark clean. The room becomes Vacant - Clean and ready.
  await page.getByRole("button", { name: "Start cleaning" }).first().click();
  await expect(page.getByText("Cleaning started.")).toBeVisible();
  await page.getByRole("button", { name: "Mark clean" }).first().click();
  await expect(page.getByText("Marked clean.")).toBeVisible();
  await expect(page.getByRole("table").getByText("Vacant – Clean").first()).toBeVisible();

  // Guest feedback: staff create a private link, the guest answers without logging in, the link works once.
  await page.goto("/app/reservations");
  await page.getByRole("link", { name: /MK-[0-9A-F]{8}/ }).first().click();
  await page.getByRole("button", { name: "Create feedback link" }).click();
  const feedbackUrl = await page.getByLabel(/Send this link to the guest/).inputValue();
  expect(feedbackUrl).toMatch(/\/feedback\/[0-9a-f-]{36}\.[\w-]{40,}$/);
  const guestCtx = await page.context().browser()!.newContext({ viewport: { width: 390, height: 800 } });
  const guest = await guestCtx.newPage();
  await guest.goto(feedbackUrl);
  await expect(guest.getByRole("heading", { name: /How was your stay, Asha\?/ })).toBeVisible();
  await expectAccessible(guest, "public feedback form");
  await expect(guest.getByText("MK-")).toHaveCount(0); // no booking reference on the public page
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await guest.getByRole("radio", { name: "Excellent (5 out of 5)" }).first().check({ force: true });
  await guest.getByLabel("Comments").fill("Wonderful stay (e2e)");
  await guest.getByRole("button", { name: "Send feedback" }).click();
  await expect(guest.getByRole("heading", { name: "Thank you!" })).toBeVisible();
  await guest.goto(feedbackUrl);
  await expect(guest.getByText(/already been submitted/)).toBeVisible();
  await guestCtx.close();
  await page.goto("/app/feedback");
  await expect(page.getByText("Wonderful stay (e2e)")).toBeVisible();
  await expectAccessible(page, "feedback dashboard with data");
  await expect(page.getByText(/Asha Verma/).first()).toBeVisible();

  // Block the room as out of order: the board shows the reason; resolving returns it needing cleaning.
  await page.goto("/app/maintenance");
  await page.getByLabel("Mark out of order (immediately)").check();
  await page.getByLabel("Reason").fill("AC not cooling");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Room 101: AC not cooling" })).toBeVisible();
  await page.goto("/app/dashboard?view=table");
  const ooo = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "101" }) });
  await expect(ooo.getByText("Out of order").first()).toBeVisible();
  await expect(ooo.getByText(/Plumbing: AC not cooling/)).toBeVisible();
  await ooo.getByRole("link", { name: "View reason" }).click();
  await page.getByLabel("What was done?").fill("Compressor replaced");
  await page.getByLabel(/I have checked the room/).check();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByText("Resolved.")).toBeVisible();
  await page.goto("/app/dashboard?view=table");
  await expect(page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "101" }) }).getByText("Cleaning required")).toBeVisible();

  // Audit trail captured the workflow.
  await page.goto("/app/audit-logs");
  for (const action of ["reservation.create", "reservation.checked_in", "reservation.checked_out", "user.mfa_enabled", "payment.record", "invoice.issue"]) {
    await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
  }

  // Sign out; login now requires the authenticator code.
  await page.getByRole("button", { name: /Sign out/ }).click();
  await signIn(page);
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, await generate({ secret }));
  await expect(page).toHaveURL(/\/app\/dashboard/);
});

test("mobile layout has no horizontal overflow on key pages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/login");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
