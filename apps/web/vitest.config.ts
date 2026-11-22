import { defineConfig } from "vitest/config";

/**
 * Unit tests run in Node against `MockAgentLayer` through the real Effect RPC
 * client; no DOM is required. The browser smoke test lives in `e2e/`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
