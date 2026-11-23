/// <reference types="vite/client" />

import type { BallastBridge } from "@ballast/desktop/bridge";

declare global {
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
