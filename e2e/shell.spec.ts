import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = `${Date.now().toString(36)}s`;

async function signUp(page: Page) {
  await page.goto("/register");
  await page.getByLabel("Business name").fill(`Shell Hotels ${stamp}`);
  await page.getByLabel("First property name").fill("Shell Inn");
  await page.getByLabel("Your name").fill("Shell Owner");
  await page.getByLabel("Email").fill(`shell-${stamp}@test.local`);
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
