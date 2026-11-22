/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_SERVICE_URL?: string;
    readonly VITE_SERVICE_TOKEN?: string;
  }
}

export {};
