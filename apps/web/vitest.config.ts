import { defineConfig } from "vitest/config";

/**
 * Unit tests run in Node against `MockAgentLayer` through the real Effect RPC
 * client; no DOM is required. Browser e2e tests live in `e2e/`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
