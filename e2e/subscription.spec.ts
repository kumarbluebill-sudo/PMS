import "dotenv/config";
import { execSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { generate } from "otplib";

const stamp = `${Date.now().toString(36)}u`;
const PW = "e2e-password-123";

async function enableMfa(page: Page) {
  await expect(page).toHaveURL(/\/security/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Confirm and enable" }).click();
  await expect(page.getByText("MFA is enabled")).toBeVisible();
}

async function signUp(page: Page, plan: string, label: string) {
  await page.goto(`/register?plan=${plan}`);
  await expect(page.getByText(/Free trial of the/)).toBeVisible();
  await page.getByLabel("Business name").fill(`Sub Hotels ${label} ${stamp}`);
  await page.getByLabel("First property name").fill("Lake Inn");
  await page.getByLabel("Your name").fill("Sub Owner");
  await page.getByLabel("Email").fill(`sub-${label}-${stamp}@test.local`);
  await page.getByLabel(/Password/).fill(PW);
  await page.getByRole("button", { name: "Create account" }).click();
  await enableMfa(page);
}

test("public pages: pricing is read from the plans, yearly toggle, contact form, robots and sitemap", async ({ page, request }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pricing");
  for (const name of ["Starter", "Professional", "Growth", "Enterprise"]) await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  await expect(page.getByText("₹999", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("₹2,499", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Talk to sales" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start free trial" }).first()).toHaveAttribute("href", /\/register\?plan=starter/);
  await page.getByRole("link", { name: "Yearly" }).click();
  await expect(page).toHaveURL(/billing=annual/);
  await expect(page.getByText("billed yearly").first()).toBeVisible();
  await expect(page.getByRole("table", { name: /Feature comparison/ })).toBeVisible();
  await expect(page.getByText("Not yet. The channel manager is planned")).toBeVisible();
  const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').first().innerText());
  expect(ld["@graph"].some((n: { "@type": string }) => n["@type"] === "FAQPage")).toBe(true);
  expect(ld["@graph"].some((n: { offers?: { priceCurrency: string } }) => n.offers?.priceCurrency === "INR")).toBe(true);

  await page.goto("/contact?demo=1");
  await page.getByLabel("Your name").fill("Meera Shah");
  await page.getByLabel("Hotel name").fill("Harbour Rooms");
  await page.getByLabel("Mobile number").fill("12345");
  await page.getByLabel("Email").fill("meera@harbour.test");
  await page.getByRole("button", { name: "Request a demo" }).click();
  await expect(page.getByRole("alert").getByText(/10-digit/)).toBeVisible();
  await page.getByLabel("Your name").fill("Meera Shah");
  await page.getByLabel("Hotel name").fill("Harbour Rooms");
  await page.getByLabel("Mobile number").fill("98765 43210");
  await page.getByLabel("Email").fill("meera@harbour.test");
  await page.getByLabel("Number of rooms").fill("20");
  await page.getByRole("button", { name: "Request a demo" }).click();
  await expect(page.getByText("We have your details")).toBeVisible();

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const rt = await robots.text();
  expect(rt).toContain("Disallow: /app/");
  expect(rt).toContain("Disallow: /platform");
  expect(rt).toContain("sitemap.xml");
  const map = await request.get("/sitemap.xml");
  expect(map.status()).toBe(200);
  expect(await map.text()).toContain("/pricing");
});

let admins = 0;
async function platformAdmin(browser: Browser) {
  const email = `platform-${stamp}-${++admins}@test.local`;
  execSync("npx tsx scripts/create-platform-admin.ts", { env: { ...process.env, PLATFORM_EMAIL: email, PLATFORM_PASSWORD: "platform-password-123" }, stdio: "pipe" });
  const ctx = await browser.newContext({ baseURL: `http://localhost:3200` });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("platform-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await enableMfa(page);
  return { page, ctx };
}

test("trial, plan limit, subscribing, payment by the platform, read-only and export", async ({ page, browser }) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUp(page, "starter", "a");
  await page.goto("/app/dashboard");
  await expect(page.getByText(/Free trial: 14 days left/)).toBeVisible();

  // Fill the Starter plan's 15 rooms, then the 16th is refused with a message that says what to do.
  await page.goto("/app/room-types");
  await page.getByLabel("Name").fill("Standard");
  await page.getByLabel("Base rate (₹)").fill("2500");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Category added.")).toBeVisible();
  const addRooms = async (from: string, to: string, expectText: string | RegExp) => {
    await page.goto("/app/rooms");
    await page.getByLabel("Prefix").fill("S");
    await page.getByLabel("First number").fill(from);
    await page.getByLabel("Last number").fill(to);
    await page.getByRole("button", { name: "Preview rooms" }).click();
    await page.getByRole("button", { name: /^Create \d+ rooms?$/ }).click();
    await expect(page.getByText(expectText).first()).toBeVisible();
  };
  await addRooms("1", "15", "Rooms created.");
  await addRooms("16", "16", "Your Starter plan allows 15 rooms. Upgrade your plan to add more.");
  await page.goto("/app/dashboard");
  await expect(page.getByText(/You have reached the 15 rooms your Starter plan allows|Free trial/).first()).toBeVisible();

  // Subscription page: usage, preview, invoice.
  await page.goto("/app/settings/subscription");
  await expect(page.getByRole("heading", { name: "Subscription & Plans", level: 1 })).toBeVisible();
  await expect(page.getByRole("img", { name: "Rooms: 15 used of 15" })).toBeVisible();
  await page.getByRole("row", { name: /Professional/ }).getByRole("link", { name: "Monthly" }).click();
  await expect(page.getByLabel("Plan change preview")).toContainText("Rs. 2,948.82");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByText("Invoice created.")).toBeVisible();
  await expect(page.getByText(/^MKS\/\d{4}-\d{2}\/\d{5}$/)).toBeVisible();
  await expect(page.getByText("How to pay")).toBeVisible();
  const pdf = await page.request.get(await page.getByRole("link", { name: "PDF" }).first().getAttribute("href") as string);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  const number = (await page.getByText(/^MKS\/\d{4}-\d{2}\/\d{5}$/).first().innerText()).trim();

  // The provider records the payment in the platform console.
  const admin = await platformAdmin(browser);
  await admin.page.goto("/platform/subscriptions");
  await admin.page.getByLabel("Hotel or plan").fill(`Sub Hotels a ${stamp}`);
  await admin.page.getByRole("button", { name: "Filter" }).click();
  await admin.page.getByRole("link", { name: new RegExp(`Sub Hotels a ${stamp}`) }).click();
  await expect(admin.page.getByRole("heading", { level: 1 })).toContainText(`Sub Hotels a ${stamp}`);
  await admin.page.getByLabel("Amount received (rupees)").fill("2948.82");
  await admin.page.getByLabel("Reference (UTR, cheque number)").fill("UTR123456");
  await admin.page.getByRole("button", { name: "Record payment" }).click();
  await expect(admin.page.getByText("Payment recorded.")).toBeVisible();
  await expect(admin.page.getByText("Active", { exact: false }).first()).toBeVisible();

  await page.goto("/app/settings/subscription");
  await expect(page.getByText("Active").first()).toBeVisible();
  await expect(page.getByText("Paid").first()).toBeVisible();
  await expect(page.getByText(number).first()).toBeVisible();
  await addRooms("16", "16", "Rooms created."); // Professional allows 50

  // A lapsed account is read-only, nothing is deleted, and the export still works.
  await admin.page.getByLabel("Action").selectOption("SUSPEND");
  await admin.page.getByLabel("Reason (recorded in the audit log)").fill("Test suspension");
  await admin.page.getByRole("button", { name: "Apply" }).click();
  await expect(admin.page.getByText("Done.")).toBeVisible();
  await page.goto("/app/rooms");
  await expect(page.getByText(/Your subscription is suspended, so this account is read-only/)).toBeVisible();
  await expect(page.getByText("Rooms (16)")).toBeVisible();
  const exp = await page.request.get("/app/settings/subscription/export");
  expect(exp.status()).toBe(200);
  expect(exp.headers()["content-type"]).toContain("spreadsheetml");

  // Hotels cannot open the platform console.
  expect((await page.goto("/platform"))?.status()).toBe(404);
  await admin.ctx.close();
});

test("platform console: plan edits reach the pricing page and every console page opens", async ({ browser, page }) => {
  test.setTimeout(240_000);
  const admin = await platformAdmin(browser);
  await admin.page.goto("/platform/plans");
  const starter = admin.page.locator("form").filter({ has: admin.page.locator('input[name="code"][value="starter"]') });
  await starter.getByLabel("Monthly price (rupees, before GST)").fill("1099");
  await starter.getByRole("button", { name: "Save plan" }).click();
  await expect(admin.page.getByText(/Plan saved/)).toBeVisible();
  await page.goto("/pricing");
  await expect(page.getByText("₹1,099", { exact: true }).first()).toBeVisible();
  // Put it back.
  await admin.page.goto("/platform/plans");
  const again = admin.page.locator("form").filter({ has: admin.page.locator('input[name="code"][value="starter"]') });
  await again.getByLabel("Monthly price (rupees, before GST)").fill("999");
  await again.getByRole("button", { name: "Save plan" }).click();
  await expect(admin.page.getByText(/Plan saved/)).toBeVisible();
  for (const path of ["/platform", "/platform/subscriptions", "/platform/renewals", "/platform/coupons", "/platform/leads", "/platform/settings"]) {
    const res = await admin.page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await expect(admin.page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await admin.ctx.close();
});

test("the daily job endpoint refuses callers without the secret", async ({ request }) => {
  const res = await request.get("/api/cron/subscriptions");
  expect([401, 404]).toContain(res.status());
});
