import { defineConfig } from "vitest/config";

// Project planning typechecks and bundles Solid artifacts in real workers;
// the default 5s budget is too tight when the monorepo suite runs in parallel.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
