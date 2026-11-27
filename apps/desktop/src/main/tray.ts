import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from "electron";
import type { ProjectMenuItem, ServiceStatus, UpdateState } from "../bridge.ts";

export interface TrayActions {
  readonly show: () => void;
  readonly openProject: (projectId: string) => void;
  readonly showLogs: () => void;
  readonly startService: () => void;
  readonly restartService: () => void;
  readonly stopService: () => void;
  readonly checkForUpdates: () => void;
  readonly installUpdate: () => void;
  readonly quit: () => void;
}

export interface TrayController {
  update(status: ServiceStatus, update: UpdateState): void;
  setProjects(projects: ReadonlyArray<ProjectMenuItem>): void;
  destroy(): void;
}

/** A tiny template image: solid ring (alpha only matters for macOS templates). */
function trayIcon(): NativeImage {
  const size = 18;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const alpha = radius <= 8 && radius >= 4.5 ? 255 : 0;
      const offset = (y * size + x) * 4;
      buffer[offset] = 0;
      buffer[offset + 1] = 0;
      buffer[offset + 2] = 0;
      buffer[offset + 3] = alpha;
    }
  }
  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

const statusLine = (status: ServiceStatus): string => {
  if (status.phase === "running") {
    const version = status.runningVersion ?? "";
    const pid = status.pid === null ? "" : " · pid " + status.pid;
    return "Running " + version + pid;
  }
  if (
    status.phase === "updating" ||
    status.phase === "starting" ||
    status.phase === "restarting" ||
    status.phase === "stopping"
  ) {
    return status.phase.charAt(0).toUpperCase() + status.phase.slice(1) + "…";
  }
  if (status.phase === "error") return "Not running (failed to start)";
  return "Not running";
};

export function createTray(actions: TrayActions): TrayController {
  const tray = new Tray(trayIcon());
  let projects: ReadonlyArray<ProjectMenuItem> = [];
  let latestStatus: ServiceStatus | undefined;
  let latestUpdate: UpdateState | undefined;
  tray.setToolTip("Ballast");
  const updateItem = (update: UpdateState): MenuItemConstructorOptions | null => {
    if (update.phase === "ready") {
      return { label: "Install update" + (update.version ? " " + update.version : "") + "…", click: actions.installUpdate };
    }
    if (update.phase === "available") {
      return { label: (update.message ?? "Update available") + "…", click: actions.installUpdate };
    }
    if (update.phase === "downloading" || update.phase === "checking") {
      return { label: update.message ?? "Checking for updates…", enabled: false };
    }
    return { label: "Check for updates…", click: actions.checkForUpdates };
  };

  const render = (status: ServiceStatus, update: UpdateState): void => {
    const updateEntry = updateItem(update);
    const projectItems: MenuItemConstructorOptions[] = projects.map((project) => ({
      label: project.name,
      click: () => actions.openProject(project.id),
    }));
    const template: MenuItemConstructorOptions[] = [
      { label: "Show Ballast", click: actions.show },
      ...(projectItems.length === 0
        ? [{ label: "No Projects", enabled: false }]
        : projectItems),
      { type: "separator" },
      { label: statusLine(status), enabled: false },
      ...(status.pendingConsents !== null && status.pendingConsents > 0
        ? [{ label: "Pending consent: " + status.pendingConsents, click: actions.show }]
        : []),
      { type: "separator" },
      ...(status.running
        ? []
        : [{ label: "Start Ballast", click: () => actions.startService() }]),
      {
        label: "Restart Ballast",
        enabled: status.running,
        click: () => actions.restartService(),
      },
      {
        label: "Stop Ballast",
        enabled: status.running,
        click: () => actions.stopService(),
      },
      ...(updateEntry ? [updateEntry] : []),
      { label: "Show logs", click: actions.showLogs },
      { type: "separator" },
      { label: "Quit Ballast UI", click: actions.quit },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(
      "Ballast — " + statusLine(status) + (status.updateAvailable ? " (restart to update)" : ""),
    );
  };

  tray.on("double-click", actions.show);

  return {
    update: (status, update) => {
      latestStatus = status;
      latestUpdate = update;
      render(status, update);
    },
    setProjects: (next) => {
      projects = next;
      if (latestStatus !== undefined && latestUpdate !== undefined) {
        render(latestStatus, latestUpdate);
      }
    },
    destroy: () => {
      tray.destroy();
    },
  };
}
