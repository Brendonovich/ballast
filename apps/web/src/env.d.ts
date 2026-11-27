/// <reference types="vite/client" />

import type { BallastBridge } from "@ballast/desktop/bridge";

declare global {
  /** Set by vite.config.ts from BALLAST_TEST_ONBOARDING; undefined under Vitest. */
  const __BALLAST_TEST_ONBOARDING__: boolean | undefined;

  interface ImportMetaEnv {
    readonly VITE_SERVICE_URL?: string;
    readonly VITE_SERVICE_TOKEN?: string;
  }

  interface Window {
    /** Injected by apps/desktop; absent in a plain browser. */
    readonly ballast?: BallastBridge;
  }
}

export {};
