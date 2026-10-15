import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = `${Date.now().toString(36)}p`;
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
};

async function signUp(page: Page) {
  await page.goto("/register");
  await page.getByLabel("Business name").fill(`Prop Hotels ${stamp}`);
  await page.getByLabel("First property name").fill("Palm Resort");
  await page.getByLabel("Your name").fill("Prop Owner");
  await page.getByLabel("Email").fill(`prop-${stamp}@test.local`);
  await page.getByLabel(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/security/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Confirm and enable" }).click();
  await expect(page.getByText("MFA is enabled")).toBeVisible();
}

async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
  expect(bad, label).toEqual([]);
}

test("property management: categories, bulk rooms, rate plans, archive and reactivate", async ({ page }) => {
  test.setTimeout(240_000);
  await signUp(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Category with a code; a duplicate name is refused with a clear message.
  await page.goto("/app/room-types");
  await page.getByLabel("Name").fill("Deluxe");
  await page.getByLabel("Code").fill("DLX");
  await page.getByLabel("Base rate (₹)").fill("4500");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Category added.")).toBeVisible();
  await page.getByLabel("Name").fill("deluxe");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert").getByText(/already exists/)).toBeVisible();

  // Bulk rooms: preview first, then create.
  await page.goto("/app/rooms");
  await page.getByLabel("Prefix").fill("D");
  await page.getByLabel("First number").fill("101");
  await page.getByLabel("Last number").fill("103");
  await page.getByRole("button", { name: "Preview rooms" }).click();
  await expect(page.getByText(/This would create 3 rooms/)).toBeVisible();
  await expect(page.getByText("D101, D102, D103")).toBeVisible();
  await page.getByRole("button", { name: "Create 3 rooms" }).click();
  await expect(page.getByText("Rooms created.")).toBeVisible();
  await expect(page.getByText("Rooms (3)")).toBeVisible();
  await shot(page, "rooms");

  // A second preview of the same range reports the clash and offers no create button.
  await page.getByLabel("Prefix").fill("D");
  await page.getByLabel("First number").fill("102");
  await page.getByLabel("Last number").fill("104");
  await page.getByRole("button", { name: "Preview rooms" }).click();
  await expect(page.getByText(/Already in use: D102, D103/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Create \d+ rooms$/ })).toHaveCount(0);

  // Rate plan: create, then see it set the price in the preview.
  await page.goto("/app/rates/new");
  await page.getByLabel("Plan name").fill("Festival");
  await page.getByLabel("Code", { exact: true }).fill("FEST");
  await page.getByLabel("Priority (higher wins an overlap)").fill("5");
  await page.getByLabel("Weekday rate for Deluxe").fill("6000");
  await page.getByLabel("Weekend rate for Deluxe").fill("7500");
  await page.getByRole("button", { name: "Create rate plan" }).click();
  await expect(page.getByText("Rate plan created.")).toBeVisible();
  await expectAccessible(page, "rate plan editor");
  await page.goto("/app/rates");
  await expect(page.getByRole("link", { name: "Festival" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Effective rates by date/ }).getByText("Festival").first()).toBeVisible();
  await shot(page, "rates");

  // A same-priority plan for the same category and dates is refused.
  await page.goto("/app/rates/new");
  await page.getByLabel("Plan name").fill("Clash");
  await page.getByLabel("Code", { exact: true }).fill("CLASH");
  await page.getByLabel("Priority (higher wins an overlap)").fill("5");
  await page.getByLabel("Weekday rate for Deluxe").fill("5000");
  await page.getByRole("button", { name: "Create rate plan" }).click();
  await expect(page.getByRole("alert").getByText(/overlaps "Festival"/)).toBeVisible();

  // Room page: archive through the confirmation dialog, then reactivate.
  await page.goto("/app/rooms");
  await page.getByRole("link", { name: "D101", exact: true }).click();
  await expectAccessible(page, "room detail");
  await page.getByRole("button", { name: "Archive room" }).first().click();
  const dialog = page.getByRole("dialog", { name: /Archive room D101/ });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Archive room" }).first().click();
  await dialog.getByLabel("Reason for archiving").fill("Renovation");
  await dialog.getByRole("button", { name: "Archive room" }).click();
  await expect(page.getByText(/Room archived/)).toBeVisible();
  await page.goto("/app/rooms");
  await expect(page.getByText("Rooms (2)")).toBeVisible();
  await page.goto("/app/rooms?status=archived");
  await expect(page.getByText("Rooms (1)")).toBeVisible();
  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(page.getByText("Room reactivated.")).toBeVisible();

  // Category page, overview, floors and property settings render and are accessible.
  await page.goto("/app/room-types");
  await page.getByRole("link", { name: "Deluxe" }).first().click();
  await expect(page.getByRole("heading", { name: /Deluxe \(DLX\)/ })).toBeVisible();
  await expectAccessible(page, "category detail");
  for (const path of ["/app/property", "/app/structure", "/app/settings/property"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Property management" })).toBeVisible();
    await expectAccessible(page, path);
  }
  await page.goto("/app/settings/property");
  await page.getByLabel("Property code").fill("PALM");
  await page.getByLabel("Phone").fill("+91 98765 43210");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Property profile saved.")).toBeVisible();

  // The invoice design preview is a PDF shown in a frame on this site: it must be allowed to be framed by this site only.
  const prev = await page.request.get("/app/settings/invoice-design/preview?theme=LUXURY");
  expect(prev.status()).toBe(200);
  expect(prev.headers()["content-type"]).toBe("application/pdf");
  expect(prev.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(prev.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  const login = await page.request.get("/login");
  expect(login.headers()["x-frame-options"]).toBe("DENY");

  // Phones: no sideways page scroll on the new screens.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/app/property", "/app/rooms", "/app/room-types", "/app/rates", "/app/structure", "/app/settings/property"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), `${path} overflow`).toBe(false);
  }
});
