import type { BallastBridge } from "@ballast/desktop/bridge";

/**
 * The Electron preload injects `window.ballast`. The web build only needs the
 * type contract; outside Electron this is undefined and Settings falls back to
 * the protocol RPCs.
 *
 * macOS Accessibility for keyboard capture is exposed through
 * `permissions.status()` / `permissions.requestAccessibility()`. The Electron
 * main process reports the result to the service through
 * `ReportShellPermission`; the renderer only displays and requests it.
 */
export const getDesktopBridge = (): BallastBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  return window.ballast;
};

export type {
  BallastBridge,
  HomeRoute,
  ProjectMenuItem,
  ServiceAction,
  ServiceStatus,
  WindowContext,
} from "@ballast/desktop/bridge";
