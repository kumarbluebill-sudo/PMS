import { defineConfig } from "@playwright/test";

const PORT = 3200;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Edge so no browser download is needed; CI can set PW_CHANNEL=chrome.
    channel: process.env.PW_CHANNEL ?? "msedge",
    trace: "retain-on-failure",
  },
  // Requires `npm run build` first. Uses the DATABASE_URL / APP_DATABASE_URL from .env.
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    env: { AUTH_URL: `http://localhost:${PORT}` },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
