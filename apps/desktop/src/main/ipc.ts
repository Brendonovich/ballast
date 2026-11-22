import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import {
  BRIDGE_CHANNELS,
  type AppInfo,
  type ServiceAction,
  type ServiceStatus,
} from "../bridge.ts";
import type { Logger } from "./logger.ts";
import type { ServiceLauncher } from "./service/launcher.ts";
import type { UpdateManager } from "./update.ts";
import type { WindowController } from "./window.ts";

export interface BridgeIpcOptions {
  readonly launcher: ServiceLauncher;
  readonly windows: WindowController;
  readonly update: UpdateManager;
  readonly appInfo: AppInfo;
  readonly logger: Logger;
  readonly showLogs: () => Promise<void>;
  readonly afterServiceChange: (status: ServiceStatus) => Promise<void>;
}

const isHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** Registers the typed IPC surface documented in apps/desktop/README.md. */
export function registerBridgeIpc(options: BridgeIpcOptions): void {
  const action = async (run: () => Promise<ServiceAction>): Promise<ServiceAction> => {
    const result = await run();
    await options.afterServiceChange(result.status);
    return result;
  };

  ipcMain.handle(BRIDGE_CHANNELS.serviceStatus, () => options.launcher.status());
  ipcMain.handle(BRIDGE_CHANNELS.serviceInstall, () => action(() => options.launcher.install()));
  ipcMain.handle(BRIDGE_CHANNELS.serviceUninstall, () => action(() => options.launcher.uninstall()));
  ipcMain.handle(BRIDGE_CHANNELS.serviceStart, () => action(() => options.launcher.start()));
  ipcMain.handle(BRIDGE_CHANNELS.serviceStop, () => action(() => options.launcher.stop()));
  ipcMain.handle(BRIDGE_CHANNELS.serviceRestart, () => action(() => options.launcher.restart()));

  ipcMain.handle(BRIDGE_CHANNELS.updateStatus, () => options.update.status());
  ipcMain.handle(BRIDGE_CHANNELS.updateInstall, async () => {
    const result = await options.update.install();
    if (!result.ok) options.logger.warn("update install was not started", { message: result.message });
    return result;
  });

  ipcMain.handle(BRIDGE_CHANNELS.appInfo, () => options.appInfo);
  ipcMain.handle(BRIDGE_CHANNELS.appOpenUi, () => options.windows.openUi());
  ipcMain.handle(BRIDGE_CHANNELS.appRetry, () => options.windows.retry());
  ipcMain.handle(BRIDGE_CHANNELS.appShowLogs, () => options.showLogs());
  ipcMain.handle(BRIDGE_CHANNELS.appOpenExternal, async (_event: IpcMainInvokeEvent, url: unknown) => {
    if (typeof url !== "string" || !isHttpUrl(url)) {
      throw new Error("only http(s) URLs can be opened externally");
    }
    await shell.openExternal(url);
  });
}
