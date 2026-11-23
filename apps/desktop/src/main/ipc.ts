import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import {
  BRIDGE_CHANNELS,
  type AppInfo,
  type ServiceAction,
  type ServiceStatus,
} from "../bridge.ts";
import type { Logger } from "./logger.ts";
import type { PermissionController } from "./permissions.ts";
import type { ServiceLauncher } from "./service/launcher.ts";
import type { UpdateManager } from "./update.ts";
import type { WindowController } from "./window.ts";

export interface BridgeIpcOptions {
  readonly launcher: ServiceLauncher;
  readonly windows: WindowController;
  readonly update: UpdateManager;
  readonly appInfo: AppInfo;
  readonly logger: Logger;
  readonly permissions: PermissionController;
  readonly showLogs: () => Promise<void>;
  readonly afterServiceChange: (status: ServiceStatus) => Promise<void>;
  readonly setProjects: (
    projects: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => void;
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
  ipcMain.handle(BRIDGE_CHANNELS.serviceStart, () => action(() => options.launcher.start()));
  ipcMain.handle(BRIDGE_CHANNELS.serviceStop, () => action(() => options.launcher.stop()));
  ipcMain.handle(BRIDGE_CHANNELS.serviceRestart, () => action(() => options.launcher.restart()));

  ipcMain.handle(BRIDGE_CHANNELS.permissionsStatus, () => options.permissions.status());
  ipcMain.handle(BRIDGE_CHANNELS.permissionsRequestAccessibility, async () => {
    const state = await options.permissions.requestAccessibility();
    await options.launcher.reportPermissions();
    await options.afterServiceChange(await options.launcher.status());
    return state;
  });

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
  ipcMain.handle(BRIDGE_CHANNELS.windowsContext, (event) =>
    options.windows.contextFor(event.sender),
  );
  ipcMain.handle(
    BRIDGE_CHANNELS.windowsOpenProject,
    async (
      event,
      projectId: unknown,
      settings: { readonly newWindow?: boolean } | undefined,
    ) => {
      if (typeof projectId !== "string" || projectId === "") {
        throw new Error("a project id is required");
      }
      await options.windows.openProjectWindow(projectId, settings, event.sender);
    },
  );
  ipcMain.handle(BRIDGE_CHANNELS.windowsOpenHome, async (_event, route: unknown) => {
    await options.windows.openHome(
      route === "connections" || route === "settings" ? route : "projects",
    );
  });
  ipcMain.handle(BRIDGE_CHANNELS.projectsSetMenu, (_event, projects: unknown) => {
    if (!Array.isArray(projects)) return;
    options.setProjects(
      projects.flatMap((value: unknown) => {
        if (typeof value !== "object" || value === null) return [];
        const id = Reflect.get(value, "id");
        const name = Reflect.get(value, "name");
        return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
      }),
    );
  });

  ipcMain.handle(BRIDGE_CHANNELS.appPickDirectory, async (event) => {
    const current = BrowserWindow.fromWebContents(event.sender);
    const picked =
      current === null
        ? await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
        : await dialog.showOpenDialog(current, {
            properties: ["openDirectory", "createDirectory"],
          });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });
}
