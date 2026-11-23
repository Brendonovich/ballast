import { defineConfig } from "vitest/config";

// The agent suite starts real services and worker processes. Running files
// sequentially keeps those services from starving each other on CI/laptops;
// each test still runs with its own real two-minute budget where needed.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
