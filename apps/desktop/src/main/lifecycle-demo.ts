import type { ServiceAction, ServiceStatus } from "../bridge.ts";
import type { DesktopConfig } from "./config.ts";
import type { ServiceLauncher } from "./service/launcher.ts";

export type DemoAction = "status" | "start" | "restart" | "stop";

const print = (payload: unknown): void => {
  console.log("BALLAST_DEMO " + JSON.stringify(payload));
};

const actionPayload = (action: ServiceAction): Record<string, unknown> => ({
  ok: action.ok,
  message: action.message,
  status: action.status,
});

/**
 * Verification-only entry point (electron . --ballast-demo=start).
 * It exercises the same launcher calls as the tray/IPC and prints one JSON
 * line per step, so a shell script can drive start, restart and stop against
 * a throwaway app id and inspect the real background process.
 */
export async function runLifecycleDemo(
  launcher: ServiceLauncher,
  config: DesktopConfig,
  action: DemoAction,
): Promise<number> {
  const base = {
    action,
    appId: config.appId,
    userDataDir: config.userDataDir,
    stateDir: config.stateDir,
    dataDir: config.dataDir,
    stageRoot: config.stageRoot,
  };

  try {
    if (action === "status") {
      const status: ServiceStatus = await launcher.status();
      print({ ...base, ok: true, status });
      return 0;
    }

    if (action === "start") {
      const before = await launcher.status();
      await launcher.prepare();
      const result = await launcher.start();
      print({ ...base, before, ...actionPayload(result) });
      return result.ok ? 0 : 1;
    }

    if (action === "restart") {
      const before = await launcher.status();
      const result = await launcher.restart();
      print({ ...base, before, ...actionPayload(result) });
      return result.ok ? 0 : 1;
    }

    const before = await launcher.status();
    const result = await launcher.stop();
    print({ ...base, before, ...actionPayload(result) });
    return result.ok ? 0 : 1;
  } catch (cause) {
    print({
      ...base,
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return 1;
  }
}
