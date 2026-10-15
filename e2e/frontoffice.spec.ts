import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = `${Date.now().toString(36)}f`;
const shot = async (page: Page, name: string, full = false) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: full });
};

async function signUp(page: Page) {
  await page.goto("/register");
  await page.getByLabel("Business name").fill(`FO Hotels ${stamp}`);
  await page.getByLabel("First property name").fill("Palm Resort");
  await page.getByLabel("Your name").fill("FO Owner");
  await page.getByLabel("Email").fill(`fo-${stamp}@test.local`);
  await page.getByLabel(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/security/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Confirm and enable" }).click();
  await expect(page.getByText("MFA is enabled")).toBeVisible();
}

test("front office: arrival to check-in to checkout control, with command centre views", async ({ page }) => {
  test.setTimeout(240_000);
  await signUp(page);

  await page.goto("/app/room-types");
  await page.getByLabel("Name").fill("Deluxe");
  await page.getByLabel("Base rate (₹)").fill("4500");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Deluxe").first()).toBeVisible();
  for (const [i, n] of ["101", "102", "103", "104", "201", "202"].entries()) {
    await page.goto("/app/rooms");
    await page.getByLabel("Room number").fill(n);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(`Rooms (${i + 1})`)).toBeVisible();
  }
  await page.goto("/app/guests");
  await page.getByLabel("Name").fill("Asha Verma");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Asha Verma")).toBeVisible();

  const plus = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  await page.goto("/app/reservations/new");
  const arrival = await page.getByLabel("Check-in").inputValue();
  await page.getByLabel("Check-out").fill(plus(arrival, 2));
  await page.getByRole("button", { name: "Check availability and price" }).click();
  await expect(page.getByText(/Deluxe room\(s\) available/)).toBeVisible();
  // Guest recognition: typing part of the name offers the existing profile; choosing it uses that profile.
  await page.getByLabel("Guest name").fill("Asha");
  await page.getByRole("option", { name: /Asha Verma/ }).click();
  await expect(page.getByText("existing guest. This booking uses their profile.")).toBeVisible();
  await page.getByLabel("Mobile number").fill("98765 43210");
  await page.getByRole("button", { name: "Save booking" }).click();
  await expect(page.getByRole("heading", { name: "Booking confirmation" })).toBeVisible();
  const id = /reservations\/([0-9a-f-]{36})\/confirmation/.exec(page.url())![1];

  // Reservation list: money columns, search and filters; calendar: the stay shows as a bar.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/reservations");
  await expect(page.getByRole("link", { name: /^R-|^[A-Z]{2,}-/ }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Balance" })).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("Asha");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("heading", { name: "Reservations (1)" })).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("zzzz-none");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("No reservations match these filters")).toBeVisible();
  await shot(page, "reservation-list");
  await page.goto("/app/reservations/calendar");
  await expect(page.getByRole("link", { name: /Asha Verma, Confirmed/ })).toBeVisible();
  await shot(page, "room-calendar");

  // Today's operations lists the arrival and links to the check-in screen.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/operations");
  const arrivals = page.locator("#arrivals");
  await expect(arrivals.getByText("Asha Verma")).toBeVisible();
  await shot(page, "operations");
  await arrivals.getByRole("link", { name: "Check in" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/check-in/${id}`));

  // ID is required before check-in when the property says so.
  await page.getByLabel("ID type").selectOption("PASSPORT");
  await page.getByLabel("ID number").fill("P1234567");
  await page.getByRole("button", { name: "Save registration" }).click();
  await expect(page.getByText("Registration complete.")).toBeVisible();
  await expect(page.getByText("ID details recorded")).toBeVisible();
  await page.getByRole("button", { name: /mark verified/ }).click();
  await expect(page.getByText("ID marked as verified.")).toBeVisible();
  await shot(page, "checkin");
  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect(page.getByRole("heading", { name: "Registration confirmation" })).toBeVisible();
  await expect(page.getByText("number not shown")).toBeVisible();
  await expect(page.getByText("P1234567")).toHaveCount(0);

  // A second check-in attempt is refused.
  await page.goto(`/app/check-in/${id}`);
  await expect(page.getByRole("button", { name: "Complete check-in" })).toBeDisabled();
  await expect(page.getByText("already checked in")).toBeVisible();

  // Command centre shows the occupied room, counts and a live occupancy figure.
  await page.goto("/app/dashboard");
  await expect(page.getByRole("list", { name: "Room status legend" }).getByRole("link", { name: /^Occupied: 1 room/ })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Occupancy" })).toHaveAttribute("aria-valuenow", "17");
  await shot(page, "command-centre");

  // Checkout control shows money and links on to the existing settlement.
  await page.goto(`/app/check-out/${id}`);
  await expect(page.getByRole("heading", { name: /Checkout: Asha Verma/ })).toBeVisible();
  await expect(page.getByText("Outstanding balance")).toBeVisible();
  await expect(page.getByRole("link", { name: "Settle and check out" })).toBeVisible();
  await shot(page, "checkout");

  await page.goto("/app/dashboard/analytics");
  await expect(page.getByText("Occupancy today")).toBeVisible();
  await shot(page, "analytics", true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/dashboard");
  await shot(page, "command-centre-phone");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});
