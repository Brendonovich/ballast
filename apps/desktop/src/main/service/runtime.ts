import type { ServiceSupervisorKind } from "../../bridge.ts";
import type { DesktopConfig } from "../config.ts";
import { createMacRuntime } from "./macos.ts";
import type { Stage } from "./types.ts";
import { createWindowsRuntime } from "./windows.ts";

/** OS-owned process supervision (launchd LaunchAgent / Task Scheduler task). */
export interface ServiceRuntime {
  readonly kind: ServiceSupervisorKind;
  readonly loginItemPath: string | null;
  isInstalled(): Promise<boolean>;
  /** Write the login item and load/start it (0003 C1/C2 install). */
  install(stage: Stage): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

/** macOS and Windows have a real login item; other platforms run a spawned process. */
export function createServiceRuntime(config: DesktopConfig): ServiceRuntime | null {
  if (config.platform === "darwin") return createMacRuntime({ config });
  if (config.platform === "win32") return createWindowsRuntime({ config });
  return null;
}
