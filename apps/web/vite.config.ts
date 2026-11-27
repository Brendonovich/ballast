import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * The build is served by the agent service at `/` on its own origin. Assets
 * are relative so the same `dist/` works behind any loopback port (and in
 * tests); the app uses hash routing, so a plain static file server needs no
 * SPA fallback.
 */
const testOnboarding = ["1", "true"].includes(process.env["BALLAST_TEST_ONBOARDING"] ?? "");

export default defineConfig({
  base: "./",
  // BALLAST_TEST_ONBOARDING=1: the mock starts as a fresh install and onboarding is not skipped.
  define: { __BALLAST_TEST_ONBOARDING__: JSON.stringify(testOnboarding) },
  plugins: [solid(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
});
