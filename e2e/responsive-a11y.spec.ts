import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = `${Date.now().toString(36)}r`;
const email = `resp-${stamp}@test.local`;
const password = "e2e-password-123";

const PAGES = [
  "/app/dashboard", "/app/front-desk", "/app/reservations", "/app/reservations/calendar", "/app/guests", "/app/billing",
  "/app/invoices", "/app/credit-notes", "/app/payments", "/app/cashier", "/app/accounting", "/app/invoices/gst-summary",
  "/app/rooms", "/app/room-types", "/app/housekeeping", "/app/maintenance", "/app/feedback", "/app/users", "/app/audit-logs",
  "/app/settings/general", "/app/settings/property", "/app/settings/reservations", "/app/settings/rooms", "/app/settings/billing",
  "/app/settings/tax", "/app/settings/security", "/app/settings/notifications", "/app/settings/channels", "/app/settings/reports",
  "/app/settings/backup", "/app/settings/subscription", "/app/settings/system", "/app/settings/permissions", "/app/structure",
  "/app/rooms/plan", "/app/rooms/import", "/app/messages", "/onboarding",
  "/app/operations", "/app/alerts", "/app/search?q=ab", "/app/dashboard/analytics",
];

async function signUp(page: Page) {
  await page.goto("/register");
  await page.getByLabel("Business name").fill(`Resp Hotels ${stamp}`);
  await page.getByLabel("First property name").fill("Resp Inn");
  await page.getByLabel("Your name").fill("Resp Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/security/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Confirm and enable" }).click();
  await expect(page.getByText("MFA is enabled")).toBeVisible();
}

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test("every app screen fits phone and tablet widths and has no serious accessibility violations", async ({ page }) => {
  test.setTimeout(240_000);
  await signUp(page);
  // Some data so tables render rows, not just empty states.
  await page.goto("/app/room-types");
  await page.getByLabel("Name").fill("Deluxe");
  await page.getByLabel("Base rate (₹)").fill("4500");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.goto("/app/rooms");
  await page.getByLabel("Room number").fill("101");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("101").first()).toBeVisible();

  const wide: string[] = [];
  const violations: string[] = [];
  for (const path of PAGES) {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const res = await page.goto(path);
      expect(res?.status(), `${path} status`).toBeLessThan(400);
      if (await overflows(page)) wide.push(`${path} @${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    for (const v of results.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
      violations.push(`${path}: ${v.id} (${v.impact}) x${v.nodes.length} e.g. ${v.nodes[0]?.target.join(" ")}`);
    }
  }
  expect(wide, `pages that scroll sideways:\n${wide.join("\n")}`).toEqual([]);
  expect(violations, `accessibility violations:\n${violations.join("\n")}`).toEqual([]);
});

test("the public pages meet the same bar", async ({ page }) => {
  for (const path of ["/", "/login", "/register", "/forgot-password"]) {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      expect(await overflows(page), `${path} @${width}`).toBe(false);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = results.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
    expect(bad, `${path}`).toEqual([]);
  }
});
