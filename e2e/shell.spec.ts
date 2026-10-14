import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = `${Date.now().toString(36)}s`;

async function signUp(page: Page) {
  await page.goto("/register");
  await page.getByLabel("Business name").fill(`Shell Hotels ${stamp}`);
  await page.getByLabel("First property name").fill("Shell Inn");
  await page.getByLabel("Your name").fill("Shell Owner");
  await page.getByLabel("Email").fill(`shell-${stamp}${Math.random().toString(36).slice(2, 7)}@test.local`);
  await page.getByLabel(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/security/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Confirm and enable" }).click();
  await expect(page.getByText("MFA is enabled")).toBeVisible();
}

test("navigation: grouped sidebar on desktop, drawer on phones", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/reservations/calendar");
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByText("Front desk", { exact: true }).first()).toBeVisible();
  await expect(nav.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Reservations" })).not.toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/app/dashboard");
  await expect(nav.getByRole("link", { name: "Guests" })).toBeHidden();
  const menu = page.getByRole("button", { name: "Open menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "Guests" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nav.getByRole("link", { name: "Guests" })).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await nav.getByRole("link", { name: "Guests" }).click();
  await expect(page).toHaveURL(/\/app\/guests/);
  await expect(nav.getByRole("link", { name: "Guests" })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});

test("room board: status key and display options in a side panel", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page);
  await page.goto("/app/room-types");
  await page.getByLabel("Name").fill("Deluxe");
  await page.getByLabel("Base rate (₹)").fill("4500");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Deluxe").first()).toBeVisible();
  await page.goto("/app/rooms");
  await page.getByLabel("Room number").fill("101");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Rooms (1)")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/dashboard");
  const key = page.getByRole("list", { name: "Room status legend" });
  await expect(key.getByRole("link", { name: /^Occupied: 0 rooms/ })).toBeVisible();
  await expect(key.getByRole("link", { name: /^Available: 1 room/ })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Occupancy" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Hotel performance summary" }).getByRole("link", { name: /Physical rooms/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^No floor assigned/ })).toBeVisible();
  await key.getByRole("link", { name: /^Occupied: 0 rooms/ }).click();
  await expect(page).toHaveURL(/status=OCCUPIED/);
  await expect(page.getByText("No rooms match these filters")).toBeVisible();
  await key.getByRole("link", { name: /^Occupied: 0 rooms.*show all/ }).click();
  await expect(page).not.toHaveURL(/status=/);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/app/dashboard");
  const open = page.getByRole("button", { name: /Performance and alerts/ });
  const alertsCard = page.getByRole("heading", { name: /^Alerts \(/ });
  await expect(alertsCard).toBeHidden();
  await open.click();
  await expect(alertsCard).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(alertsCard).toBeHidden();
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test("command centre: header, quick actions, settings drawer, worklists and analytics", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/dashboard");
  await expect(page.getByRole("search")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Quick actions" }).getByRole("link", { name: "New reservation" })).toBeVisible();
  // the dashboard opens with the narrow icon rail; the toggle expands it
  const toggle = page.getByRole("button", { name: /Expand menu/ });
  await toggle.click();
  await expect(page.getByRole("navigation", { name: "Sections" }).getByText("Housekeeping", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const drawer = page.getByRole("dialog", { name: "Settings" });
  await expect(drawer.getByRole("link", { name: /Room-status colours/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await page.goto("/app/operations");
  await expect(page.getByRole("heading", { name: "Today's operations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^No-show candidates/ })).toBeVisible();
  await page.goto("/app/search?q=zz");
  await expect(page.getByText(/Nothing found/)).toBeVisible();
  await page.goto("/app/alerts");
  await expect(page.getByRole("heading", { name: "Alerts and tasks" })).toBeVisible();
  await page.goto("/app/dashboard/analytics");
  await expect(page.getByRole("heading", { name: "Occupancy and revenue" })).toBeVisible();
});
