import { app, dialog, shell } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AppInfo,
  ProjectMenuItem,
  ServiceAction,
  ServiceStatus,
  UpdateState,
} from "../bridge.ts";
import { resolveConfig } from "./config.ts";
import { registerBridgeIpc } from "./ipc.ts";
import { runLifecycleDemo, type DemoAction } from "./lifecycle-demo.ts";
import { createLogger } from "./logger.ts";
import { installApplicationMenu } from "./menu.ts";
import { createPermissionController } from "./permissions.ts";
import { createServiceLauncher } from "./service/launcher.ts";
import { createTray, type TrayController } from "./tray.ts";
import { createUpdateManager } from "./update.ts";
import { createWindowController, type WindowController } from "./window.ts";
import { readWindowSession } from "./window-state.ts";

const demoActions: ReadonlyArray<DemoAction> = ["status", "start", "restart", "stop"];

const readFlag = (prefix: string): string | undefined => {
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
};

const demoRaw = readFlag("--ballast-demo=");
const demo: DemoAction | undefined = demoActions.find((action) => action === demoRaw);
const background = process.argv.includes("--background");
/** Every launch starts (or updates) the background service unless BALLAST_AUTOSTART=0. */
const autostart = process.env["BALLAST_AUTOSTART"] !== "0";
const quitAfterRaw = readFlag("--ballast-quit-after-ms=");
const quitAfterMs = quitAfterRaw === undefined ? undefined : Number(quitAfterRaw);

const userDataOverride = process.env.BALLAST_USER_DATA_DIR;
if (userDataOverride !== undefined && userDataOverride.length > 0) {
  app.setPath("userData", path.resolve(userDataOverride));
}
app.setName("Ballast");

let windows: WindowController | null = null;

const hasLock = demo !== undefined || quitAfterMs !== undefined || app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    windows?.show();
  });
  void start().catch((cause: unknown) => {
    console.error("Ballast desktop failed to start", cause);
    app.exit(1);
  });
}

async function start(): Promise<void> {
  await app.whenReady();

  const config = resolveConfig({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    homeDir: app.getPath("home"),
    userDataDir: app.getPath("userData"),
    appVersion: app.getVersion(),
  });

  if (path.resolve(app.getPath("userData")) !== config.userDataDir) {
    app.setPath("userData", config.userDataDir);
  }
  if (process.platform === "win32") app.setAppUserModelId(config.appId);

  const logger = createLogger(config.logDir);
  logger.info("desktop starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userDataDir: config.userDataDir,
    stateDir: config.stateDir,
  });

  const restoredWindows = await readWindowSession(config.userDataDir);
  const permissions = createPermissionController(process.platform);
  const launcher = createServiceLauncher(config, {
    logger,
    permissions: () => permissions.status(),
  });

  if (demo !== undefined) {
    const code = await runLifecycleDemo(launcher, config, demo);
    app.exit(code);
    return;
  }

  let latestStatus: ServiceStatus | null = null;
  let lastSerialized = "";
  let tray: TrayController | null = null;
  let update: ReturnType<typeof createUpdateManager> | null = null;
  let knownProjects: ReadonlyArray<ProjectMenuItem> = [];

  const showLogs = async (): Promise<void> => {
    await mkdir(config.logDir, { recursive: true, mode: 0o700 });
    const failure = await shell.openPath(config.logDir);
    if (failure.length > 0) logger.warn("failed to open log folder", { message: failure });
  };

  const broadcastUpdate = (state: UpdateState): void => {
    windows?.broadcastUpdateStatus(state);
    if (tray !== null && latestStatus !== null) tray.update(latestStatus, state);
  };

  const refreshStatus = async (): Promise<ServiceStatus> => {
    const status = await launcher.status();
    latestStatus = status;
    const serialized = JSON.stringify(status);
    if (serialized !== lastSerialized && tray !== null) {
      lastSerialized = serialized;
      windows?.broadcastServiceStatus(status);
      if (update !== null) tray.update(status, update.status());
    }
    await windows?.sync(status);
    await launcher.reportPermissions();
    return status;
  };

  const afterServiceChange = async (status: ServiceStatus): Promise<void> => {
    latestStatus = status;
    lastSerialized = JSON.stringify(status);
    windows?.broadcastServiceStatus(status);
    if (tray !== null && update !== null) tray.update(status, update.status());
    await windows?.sync(status);
    await launcher.reportPermissions();
  };

  const perform = async (label: string, run: () => Promise<ServiceAction>): Promise<void> => {
    try {
      const result = await run();
      await refreshStatus();
      if (!result.ok) dialog.showErrorBox(label + " failed", result.message ?? "Unknown error");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error(label + " failed", { message });
      dialog.showErrorBox(label + " failed", message);
    }
  };

  update = createUpdateManager({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    currentVersion: app.getVersion(),
    feedUrl: process.env["BALLAST_UPDATE_URL"],
    logger,
    onState: broadcastUpdate,
    beforeInstall: () => launcher.prepareForAppUpdate(),
  });

  const windowsController = createWindowController({
    config,
    logger,
    getStatus: () => launcher.status(),
    getConnection: () => launcher.getConnection(),
    showLogs,
    restoredWindows,
  });
  windows = windowsController;

  const currentUpdate = update;
  const checkForUpdates = (): void => {
    void currentUpdate.check();
  };
  const installUpdate = (): void => {
    void currentUpdate.install().then((result) => {
      if (!result.ok && result.message !== null) dialog.showErrorBox("Install update failed", result.message);
      broadcastUpdate(result.state);
    });
  };

  const setProjects = (projects: ReadonlyArray<ProjectMenuItem>): void => {
    const seen = new Set<string>();
    knownProjects = projects.filter((project) => {
      if (seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    });
    tray?.setProjects(knownProjects);
    installApplicationMenu(menuActions, knownProjects);
  };

  tray = createTray({
    show: () => windowsController.show(),
    openProject: (projectId) => {
      void windowsController.focusOrOpen(projectId);
    },
    showLogs: () => {
      void showLogs();
    },
    startService: () => {
      void perform("Start Ballast", () => launcher.start());
    },
    restartService: () => {
      void perform("Restart Ballast", () => launcher.restart());
    },
    stopService: () => {
      void perform("Stop Ballast", () => launcher.stop());
    },
    checkForUpdates,
    installUpdate,
    quit: () => app.quit(),
  });

  const menuActions = {
    show: () => windowsController.show(),
    newWindow: () => windowsController.newHomeWindow(),
    openProject: (projectId: string) => {
      void windowsController.openProjectWindow(projectId, { newWindow: false });
    },
    showLogs: () => {
      void showLogs();
    },
    restartService: () => {
      void perform("Restart Ballast", () => launcher.restart());
    },
    stopService: () => {
      void perform("Stop Ballast", () => launcher.stop());
    },
    startService: () => {
      void perform("Start Ballast", () => launcher.start());
    },
    checkForUpdates,
    installUpdate,
  };
  installApplicationMenu(menuActions, knownProjects);

  const appInfo: AppInfo = {
    name: "Ballast",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  };

  registerBridgeIpc({
    launcher,
    windows: windowsController,
    update: currentUpdate,
    appInfo,
    logger,
    permissions,
    showLogs,
    afterServiceChange,
    setProjects,
  });

  app.on("activate", () => windowsController.show());
  app.on("window-all-closed", () => {
    // The window is not the service: Ballast stays in the tray and the
    // detached background service keeps running (0003 §2).
  });
  app.on("before-quit", () => {
    windowsController.beforeQuit();
    logger.info("desktop quitting; background service is not stopped");
  });

  const initialStatus = await refreshStatus();

  // Like the OpenCode background service: adopt a running service of the
  // shipped version, replace one of another version, or spawn a new one.
  // A relaunch after an app update lands here too. Wait for this before the
  // first window so a replacement never strands it on the fallback page.
  if (autostart && (!initialStatus.running || initialStatus.updateAvailable)) {
    logger.info("starting background service", {
      phase: initialStatus.phase,
      runningVersion: initialStatus.runningVersion,
      builtVersion: initialStatus.builtVersion,
    });
    await perform("Start Ballast", () => launcher.start());
  }

  if (!background) windowsController.showInitial();

  let statusTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (delayMs: number): void => {
    statusTimer = setTimeout(() => {
      void refreshStatus()
        .catch((cause: unknown) => {
          logger.warn("status refresh failed", {
            message: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          scheduleRefresh(windowsController.hasFallback() ? 1_000 : 5_000);
        });
    }, delayMs);
    statusTimer.unref();
  };
  scheduleRefresh(5_000);
  app.on("will-quit", () => {
    if (statusTimer !== undefined) clearTimeout(statusTimer);
  });

  // Stage the shipped service and clean old versions in the background.
  void launcher.prepare().then(() => refreshStatus()).catch(() => undefined);

  if (quitAfterMs !== undefined && Number.isFinite(quitAfterMs)) {
    setTimeout(() => {
      void (async () => {
        const status = await refreshStatus();
        const win = windowsController.current();
        let ui: unknown = null;
        if (win !== null && !win.isDestroyed()) {
          try {
            ui = await win.webContents.executeJavaScript(
              "(async () => { const bridge = window.ballast; if (!bridge) return { hasBridge: false }; " +
                "const status = await bridge.service.status(); " +
                "return { hasBridge: true, title: document.title, href: location.origin + location.pathname, " +
                "phase: status.phase, running: status.running }; })()",
            );
          } catch (cause) {
            ui = { hasBridge: false, error: cause instanceof Error ? cause.message : String(cause) };
          }
        }
        console.log("BALLAST_SMOKE " + JSON.stringify({ status, ui }));
        app.quit();
      })();
    }, quitAfterMs);
  }
}
