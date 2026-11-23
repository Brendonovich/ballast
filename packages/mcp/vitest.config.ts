import { defineConfig } from "vitest/config";

// The suite starts a real Ballast service and an MCP stdio process, so files
// run sequentially and each test gets a realistic budget.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
