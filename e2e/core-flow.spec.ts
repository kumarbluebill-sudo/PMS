import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = Date.now().toString(36);
const email = `e2e-${stamp}@test.local`;
const password = "e2e-password-123";

const isoPlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

  // Guest + reservation starting today.
  await page.goto("/app/guests");
  await page.getByLabel("Name").fill("Asha Verma");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Asha Verma")).toBeVisible();

  await page.goto("/app/reservations");
  await page.getByLabel("Arrival").fill(isoPlus(0));
  await page.getByLabel("Departure").fill(isoPlus(2));
  await page.getByRole("button", { name: "Book" }).click();
  await expect(page.getByRole("cell", { name: "Asha Verma" })).toBeVisible();
  await expect(page.getByText(/MK-[0-9A-F]{8}/)).toBeVisible();

  // A second booking for the only room on the same dates must be refused with a clear message.
  await page.getByLabel("Arrival").fill(isoPlus(1));
  await page.getByLabel("Departure").fill(isoPlus(3));
  await page.getByRole("button", { name: "Book" }).click();
  await expect(page.getByText(/No room of this type is available/)).toBeVisible();

  // Front desk: check in, then out.
  await page.goto("/app/front-desk");
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText("In house (1)")).toBeVisible();

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

  // Now check-out succeeds.
  await page.goto("/app/front-desk");
  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByText("In house (0)")).toBeVisible();

  // Housekeeping shows the room dirty after checkout.
  await page.goto("/app/housekeeping");
  await expect(page.getByText("dirty").first()).toBeVisible();

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
