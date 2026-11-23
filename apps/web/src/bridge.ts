import type { BallastBridge, ServiceAction, ServiceStatus } from "@ballast/desktop/bridge";

/**
 * The Electron preload injects `window.ballast`. The web build only needs the
 * type contract; outside Electron this is undefined and Settings falls back to
 * the protocol RPCs.
 *
 * HOOK(permissions): when apps/desktop adds `permissions.requestAccessibility()`
 * for macOS keyboard capture, call it from the keyboard connection dialog and
 * render the granted/denied result here. Do not add a second IPC surface in the
 * renderer.
 */
export const getDesktopBridge = (): BallastBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  return window.ballast;
};

export type { BallastBridge, ServiceAction, ServiceStatus };
