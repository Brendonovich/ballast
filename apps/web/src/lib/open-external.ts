import { getDesktopBridge } from "../bridge.ts";

/** Open a URL in the system browser (desktop) or a new tab (web UI). */
export const openExternal = (url: string): void => {
  const bridge = getDesktopBridge();
  if (bridge !== undefined) {
    void bridge.app.openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
    return;
  }
  window.open(url, "_blank", "noopener");
};
