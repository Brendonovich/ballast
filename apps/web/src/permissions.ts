import { createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";
import type { PermissionStatus } from "@ballast/agent-protocol";

import { getDesktopBridge } from "./bridge.ts";
import { useAgent } from "./state/context.tsx";
import { toast } from "./ui/toast.tsx";

export interface AccessibilityPermission {
  readonly status: Accessor<PermissionStatus | undefined>;
  readonly requesting: Accessor<boolean>;
  readonly request: () => Promise<void>;
  readonly hasBridge: boolean;
}

/**
 * Reads the shell-owned Accessibility status once and owns the request action.
 * The Electron main process reports the result through ReportShellPermission;
 * an initial non-granted state is only reported when no keyboard connection
 * exists to reconcile.
 */
export const useAccessibilityPermission = (): AccessibilityPermission => {
  const store = useAgent();
  const bridge = getDesktopBridge();
  const [status, setStatus] = createSignal<PermissionStatus>();
  const [requesting, setRequesting] = createSignal(false);

  onMount(() => {
    if (bridge === undefined) return;
    let active = true;
    void bridge.permissions
      .status()
      .then(async (next) => {
        if (!active) return;
        setStatus(next.accessibility);
        const hasKeyboard = store
          .connections()
          .some((connection) => connection.integration === "keyboard");
        if (next.accessibility !== "granted" && !hasKeyboard) {
          await store.reportShellPermission("accessibility", next.accessibility);
        }
      })
      .catch(() => {
        // Permission status is optional; connection management still works.
      });
    onCleanup(() => {
      active = false;
    });
  });

  const request = async (): Promise<void> => {
    if (bridge === undefined) return;
    setRequesting(true);
    try {
      const next = await bridge.permissions.requestAccessibility();
      setStatus(next.accessibility);
    } catch (error) {
      toast.error(
        "Accessibility request failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRequesting(false);
    }
  };

  return {
    status,
    requesting,
    request,
    hasBridge: bridge !== undefined,
  };
};
