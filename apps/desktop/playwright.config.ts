import { defineConfig } from "@playwright/test";

/**
 * The desktop E2E builds the real agent service (`apps/agent/dist-service`)
 * and the Electron main/preload, then starts it as a detached background
 * process against throwaway state/data dirs. The rest of the suite stays in vitest.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
