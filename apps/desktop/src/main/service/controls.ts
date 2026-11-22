import type { ServiceRegistration } from "./types.ts";

/**
 * Stub/dev control endpoints. The real service (apps/agent) will expose
 * ShutdownService / RestartService over RPC; the launcher falls back to the OS
 * supervisor (launchctl kickstart / schtasks) when these return false.
 */
export async function requestServiceControl(
  registration: ServiceRegistration,
  action: "shutdown" | "restart",
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/" + action, registration.url), {
      method: "POST",
      headers: { Authorization: "Bearer " + registration.token, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
