import { systemPreferences } from "electron";
import type { PermissionStatus, ServicePermissions } from "../bridge.ts";

export interface PermissionController {
  /** Query without prompting; safe to call on every status refresh. */
  status(): ServicePermissions;
  /**
   * macOS: `isTrustedAccessibilityClient(true)` shows the Accessibility prompt
   * or opens System Settings. The user may grant it later, so callers refresh
   * the status afterwards instead of treating the immediate result as final.
   */
  requestAccessibility(): Promise<ServicePermissions>;
}

const accessibility = (platform: NodeJS.Platform, prompt: boolean): PermissionStatus => {
  if (platform !== "darwin") return "granted";
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
};

export const createPermissionController = (
  platform: NodeJS.Platform = process.platform,
): PermissionController => ({
  status: () => ({ accessibility: accessibility(platform, false) }),
  requestAccessibility: async () => ({ accessibility: accessibility(platform, true) }),
});
