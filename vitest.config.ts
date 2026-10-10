import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
