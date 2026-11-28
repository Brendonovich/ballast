import { BrowserWindow, shell } from "electron";
import type { WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_CHANNELS,
  type HomeRoute,
  type RescopeResult,
  type ServiceStatus,
  type UpdateState,
  type WindowContext,
} from "../bridge.ts";
import { APP_ORIGIN, setAppProtocolTarget } from "./app-protocol.ts";
import type { DesktopConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import {
  writeWindowSession,
  writeWindowSessionSync,
  type RestoredWindows,
  type StoredBounds,
} from "./window-state.ts";
import { devWindowUrl, planRescope, titleBarOptions } from "./window-scope.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(here, "../preload/index.cjs");
const fallbackPath = path.resolve(here, "../renderer/fallback.html");

type WindowMode = "none" | "fallback" | "service" | "dev";

export interface WindowConnection {
  readonly url: string;
  readonly token: string;
}

export interface WindowControllerOptions {
  readonly config: DesktopConfig;
  readonly logger: Logger;
  readonly getStatus: () => Promise<ServiceStatus>;
  readonly getConnection: () => Promise<WindowConnection | null>;
  readonly showLogs: () => Promise<void>;
  readonly restoredWindows: RestoredWindows;
}

interface WindowRecord {
  readonly window: BrowserWindow;
  kind: "home" | "project" | "artifact";
  projectId?: string;
  artifact?: string;
  route: HomeRoute;
  mode: WindowMode;
  loadedOrigin: string | null;
  loadedPid: number | null;
  loadedKey: string | null;
  lastFocusedAt: number;
}

export interface WindowController {
  /** Focus a window, or open home when none exist. */
  show(): void;
  /** Restore project windows, or open one home window when there are none. */
  showInitial(): void;
  /** Cmd/Ctrl+N: always a fresh home window. */
  newHomeWindow(): void;
  openProjectWindow(
    projectId: string,
    options?: { readonly newWindow?: boolean },
    sender?: WebContents,
  ): Promise<void>;
  /** Focus an existing artifact window, otherwise open a new one. */
  openArtifactWindow(projectId: string, artifact: string): Promise<void>;
  /** Switch the sender's window to a project, or focus the one showing it. */
  rescopeProject(projectId: string, sender: WebContents): RescopeResult;
  /** Focus an existing project window, otherwise open a new one. */
  focusOrOpen(projectId: string): Promise<void>;
  openHome(route?: HomeRoute): Promise<void>;
  contextFor(sender?: WebContents): WindowContext;
  sync(status: ServiceStatus): Promise<void>;
  /** True while any window is on the bundled fallback page. */
  hasFallback(): boolean;
  openUi(): Promise<void>;
  retry(): Promise<void>;
  broadcastServiceStatus(status: ServiceStatus): void;
  broadcastUpdateStatus(state: UpdateState): void;
  current(): BrowserWindow | null;
  beforeQuit(): void;
  hide(): void;
  close(): void;
}

const isHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

const routeHash = (record: WindowRecord): string => {
  if (
    record.kind === "artifact" &&
    record.projectId !== undefined &&
    record.artifact !== undefined
  ) {
    return (
      "#/projects/" +
      encodeURIComponent(record.projectId) +
      "/artifacts/" +
      encodeURIComponent(record.artifact)
    );
  }
  if (record.kind === "project" && record.projectId !== undefined) {
    return "#/projects/" + encodeURIComponent(record.projectId);
  }
  return record.route === "projects" ? "" : "#/" + record.route;
};

const titleFor = (record: WindowRecord): string =>
  record.kind === "project" ? "Ballast" : "Ballast";

export function createWindowController(options: WindowControllerOptions): WindowController {
  const { config, logger } = options;
  const records: WindowRecord[] = [];
  let lastStatus: ServiceStatus | null = null;
  let quitting = false;
  let saveTimer: NodeJS.Timeout | undefined;

  const recordFor = (contents: WebContents): WindowRecord | undefined =>
    records.find(
      (record) => !record.window.isDestroyed() && record.window.webContents === contents,
    );

  const focusedRecord = (): WindowRecord | undefined => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused !== null) {
      const record = records.find((entry) => entry.window === focused);
      if (record !== undefined) return record;
    }
    return records
      .filter((record) => !record.window.isDestroyed())
      .slice()
      .sort((left, right) => right.lastFocusedAt - left.lastFocusedAt)[0];
  };

  const focus = (record: WindowRecord): void => {
    if (record.window.isDestroyed()) return;
    if (record.window.isMinimized()) record.window.restore();
    record.window.show();
    record.window.focus();
  };

  const sessionOf = (): RestoredWindows => {
    const projects: Array<{ readonly projectId: string; readonly bounds: StoredBounds }> = [];
    const artifacts: Array<{
      readonly projectId: string;
      readonly artifact: string;
      readonly bounds: StoredBounds;
    }> = [];
    for (const record of records) {
      if (record.projectId === undefined) continue;
      const bounds = record.window.getBounds();
      const value = {
        projectId: record.projectId,
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      };
      if (record.kind === "project") projects.push(value);
      if (record.kind === "artifact" && record.artifact !== undefined) {
        artifacts.push({ ...value, artifact: record.artifact });
      }
    }
    return { projects, artifacts };
  };

  const saveNow = (): void => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    void writeWindowSession(config.userDataDir, sessionOf()).catch((cause: unknown) => {
      logger.warn("could not save window session", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };

  const scheduleSave = (): void => {
    if (quitting) return;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
    saveTimer.unref();
  };

  const loadFallback = async (record: WindowRecord): Promise<void> => {
    if (record.window.isDestroyed() || record.mode === "fallback") return;
    record.mode = "fallback";
    record.loadedOrigin = null;
    record.loadedPid = null;
    record.loadedKey = "fallback";
    try {
      await record.window.loadFile(fallbackPath);
    } catch (cause) {
      logger.error("failed to load fallback page", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const loadService = async (
    record: WindowRecord,
    connection: WindowConnection,
    status: ServiceStatus,
    key: string,
  ): Promise<void> => {
    if (record.window.isDestroyed()) return;
    setAppProtocolTarget(connection);
    const url = new URL(APP_ORIGIN + "/");
    const hash = routeHash(record);
    if (hash !== "") url.hash = hash;
    record.mode = "service";
    record.loadedOrigin = APP_ORIGIN;
    record.loadedPid = status.pid;
    record.loadedKey = key;
    try {
      await record.window.loadURL(url.toString());
    } catch (cause) {
      logger.warn("failed to load service UI", {
        origin: connection.url,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      record.mode = "none";
      await loadFallback(record);
    }
  };

  const syncRecord = async (record: WindowRecord, status: ServiceStatus): Promise<void> => {
    if (record.window.isDestroyed()) return;

    if (config.uiUrl !== undefined) {
      if (!status.running || status.url === null) {
        await loadFallback(record);
        return;
      }
      const connection = await options.getConnection();
      if (connection === null) {
        await loadFallback(record);
        return;
      }
      const target = new URL(devWindowUrl(config.uiUrl, connection, routeHash(record)));
      const key = target.toString();
      if (record.mode !== "dev" || record.loadedKey !== key) {
        record.mode = "dev";
        record.loadedOrigin = target.origin;
        record.loadedPid = status.pid;
        record.loadedKey = key;
        try {
          await record.window.loadURL(key);
        } catch (cause) {
          logger.warn("failed to load BALLAST_UI_URL", {
            message: cause instanceof Error ? cause.message : String(cause),
          });
          record.mode = "none";
          await loadFallback(record);
        }
      }
      return;
    }

    if (!status.running || status.url === null) {
      await loadFallback(record);
      return;
    }

    const key = [status.url, status.pid ?? "none", routeHash(record)].join("|");
    if (
      record.mode === "service" &&
      record.loadedKey?.startsWith(status.url + "|") === true &&
      record.loadedPid === status.pid &&
      record.loadedKey === key
    ) {
      return;
    }

    const connection = await options.getConnection();
    if (connection === null) {
      await loadFallback(record);
      return;
    }
    await loadService(record, connection, status, key);
  };

  const syncRecordWithCurrentStatus = async (record: WindowRecord): Promise<void> => {
    const status = lastStatus ?? (await options.getStatus());
    lastStatus = status;
    await syncRecord(record, status);
  };

  const secure = (record: WindowRecord) => {
    const created = record.window;
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith("file:")) {
        event.preventDefault();
        return;
      }
      if (record.loadedOrigin !== null && originOf(url) === record.loadedOrigin) {
        return;
      }
      if (isHttpUrl(url)) {
        event.preventDefault();
        void shell.openExternal(url);
      } else {
        event.preventDefault();
      }
    });
    created.webContents.on("will-attach-webview", (event) => event.preventDefault());
    created.webContents.on("page-title-updated", (_event, title) => {
      if (!created.isDestroyed()) created.setTitle(title);
    });
    const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications"]);
    const trustedPage = (contents: Electron.WebContents): boolean => {
      try {
        const url = new URL(contents.getURL());
        return url.protocol === "http:" || url.protocol === "https:" || url.origin === APP_ORIGIN;
      } catch {
        return false;
      }
    };
    created.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
      callback(rendererPermissions.has(permission) && trustedPage(contents));
    });
    created.webContents.session.setPermissionCheckHandler((contents, permission) =>
      contents !== null && rendererPermissions.has(permission) && trustedPage(contents),
    );
    created.webContents.on(
      "did-fail-load",
      (_event, errorCode, description, failedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        logger.warn("window failed to load", {
          errorCode,
          description,
          url: failedUrl.replace(/token=[^&]+/, "token=[redacted]"),
        });
        void loadFallback(record);
      },
    );
    created.webContents.on("render-process-gone", (_event, details) => {
      logger.error("renderer process gone", { reason: details.reason });
      void loadFallback(record);
    });
    created.on("focus", () => {
      record.lastFocusedAt = Date.now();
    });
    created.on("resize", scheduleSave);
    created.on("move", scheduleSave);
    created.on("closed", () => {
      const index = records.indexOf(record);
      if (index >= 0) records.splice(index, 1);
      if (record.kind === "project" && record.projectId !== undefined) {
        for (const artifactWindow of records.filter(
          (candidate) =>
            candidate.kind === "artifact" && candidate.projectId === record.projectId,
        )) {
          artifactWindow.window.close();
        }
      }
      if (!quitting) scheduleSave();
    });
  };

  const createRecord = (
    initial: Pick<WindowRecord, "kind" | "route"> & {
      readonly projectId?: string;
      readonly artifact?: string;
      readonly bounds?: StoredBounds;
    },
  ): WindowRecord => {
    const bounds = initial.bounds;
    const created = new BrowserWindow({
      ...(bounds === undefined
        ? {}
        : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
      ...(bounds === undefined ? { width: 1180, height: 780 } : {}),
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: "Ballast",
      backgroundColor: "#0b0d10",
      autoHideMenuBar: process.platform !== "darwin",
      ...titleBarOptions(process.platform),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const record: WindowRecord = {
      window: created,
      kind: initial.kind,
      ...(initial.projectId === undefined ? {} : { projectId: initial.projectId }),
      ...(initial.artifact === undefined ? {} : { artifact: initial.artifact }),
      route: initial.route,
      mode: "none",
      loadedOrigin: null,
      loadedPid: null,
      loadedKey: null,
      lastFocusedAt: Date.now(),
    };
    records.push(record);
    secure(record);
    created.once("ready-to-show", () => {
      if (!created.isDestroyed()) created.show();
    });
    created.setTitle(titleFor(record));
    void syncRecordWithCurrentStatus(record);
    if (initial.kind !== "home") scheduleSave();
    return record;
  };

  const convertToProject = async (record: WindowRecord, projectId: string): Promise<void> => {
    record.kind = "project";
    record.projectId = projectId;
    record.mode = "none";
    record.loadedKey = null;
    record.window.setTitle("Ballast");
    scheduleSave();
    focus(record);
    await syncRecordWithCurrentStatus(record);
  };

  const openProjectInNewWindow = async (projectId: string): Promise<void> => {
    const record = createRecord({ kind: "project", projectId, route: "projects" });
    focus(record);
    await syncRecordWithCurrentStatus(record);
  };

  const findProjectWindow = (projectId: string): WindowRecord | undefined =>
    records.find(
      (record) =>
        record.kind === "project" &&
        record.projectId === projectId &&
        !record.window.isDestroyed(),
    );

  const findArtifactWindow = (
    projectId: string,
    artifact: string,
  ): WindowRecord | undefined =>
    records.find(
      (record) =>
        record.kind === "artifact" &&
        record.projectId === projectId &&
        record.artifact === artifact &&
        !record.window.isDestroyed(),
    );

  const openArtifactWindow = async (
    projectId: string,
    artifact: string,
  ): Promise<void> => {
    const existing = findArtifactWindow(projectId, artifact);
    if (existing !== undefined) {
      focus(existing);
      return;
    }
    const record = createRecord({
      kind: "artifact",
      projectId,
      artifact,
      route: "projects",
    });
    focus(record);
    await syncRecordWithCurrentStatus(record);
  };

  const show = (): void => {
    const record = focusedRecord();
    if (record !== undefined) {
      focus(record);
      return;
    }
    void openHome("projects");
  };

  const openHome = async (route: HomeRoute = "projects"): Promise<void> => {
    const home = records.find(
      (record) => record.kind === "home" && !record.window.isDestroyed(),
    );
    if (home !== undefined) {
      home.route = route;
      focus(home);
      await syncRecordWithCurrentStatus(home);
      return;
    }
    const record = createRecord({ kind: "home", route });
    focus(record);
    await syncRecordWithCurrentStatus(record);
  };

  const openProjectWindow = async (
    projectId: string,
    openOptions: { readonly newWindow?: boolean } = {},
    sender?: WebContents,
  ): Promise<void> => {
    const existing = findProjectWindow(projectId);
    if (existing !== undefined) {
      focus(existing);
      return;
    }

    if (openOptions.newWindow !== true) {
      const source =
        (sender === undefined ? undefined : recordFor(sender)) ?? focusedRecord();
      if (source !== undefined && source.kind === "home") {
        await convertToProject(source, projectId);
        return;
      }
    }

    await openProjectInNewWindow(projectId);
  };

  // The renderer navigates in place after a re-scope, so only the record and
  // its load key change; a later status sync then sees nothing to reload.
  const rescopeProject = (projectId: string, sender: WebContents): RescopeResult => {
    const source = recordFor(sender);
    const plan = planRescope(
      records
        .filter((record) => !record.window.isDestroyed())
        .map((record) => ({
          id: record.window.id,
          kind: record.kind,
          ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
        })),
      source?.window.id,
      projectId,
    );
    if (plan.action === "reject" || source === undefined) {
      throw new Error("cannot switch project: " + (plan.action === "reject" ? plan.reason : ""));
    }
    if (plan.action === "focus") {
      const target = records.find((record) => record.window.id === plan.id);
      if (target !== undefined) focus(target);
      return { outcome: "focused" };
    }
    if (plan.action === "rescope") {
      source.kind = "project";
      source.projectId = projectId;
      if (source.mode === "service") {
        source.loadedKey = [source.loadedKey?.split("|")[0] ?? "", source.loadedPid ?? "none", routeHash(source)].join("|");
      } else if (source.mode === "dev" && config.uiUrl !== undefined) {
        const target = new URL(source.loadedKey ?? config.uiUrl);
        target.hash = routeHash(source);
        source.loadedKey = target.toString();
      }
      scheduleSave();
    }
    return { outcome: "rescoped" };
  };

  const focusOrOpen = async (projectId: string): Promise<void> => {
    const existing = findProjectWindow(projectId);
    if (existing !== undefined) {
      focus(existing);
      return;
    }
    await openProjectInNewWindow(projectId);
  };

  return {
    show,
    showInitial: () => {
      const restored = options.restoredWindows;
      if (restored.projects.length > 0 || restored.artifacts.length > 0) {
        for (const project of restored.projects) {
          createRecord({
            kind: "project",
            projectId: project.projectId,
            route: "projects",
            ...(project.bounds === undefined ? {} : { bounds: project.bounds }),
          });
        }
        for (const artifact of restored.artifacts) {
          createRecord({
            kind: "artifact",
            projectId: artifact.projectId,
            artifact: artifact.artifact,
            route: "projects",
            ...(artifact.bounds === undefined ? {} : { bounds: artifact.bounds }),
          });
        }
        const last = records.at(-1);
        if (last !== undefined) focus(last);
        return;
      }
      void openHome("projects");
    },
    newHomeWindow: () => {
      const record = createRecord({ kind: "home", route: "projects" });
      focus(record);
      void syncRecordWithCurrentStatus(record);
    },
    openProjectWindow,
    openArtifactWindow,
    rescopeProject,
    focusOrOpen,
    openHome,
    contextFor: (sender) => {
      const record =
        sender === undefined ? focusedRecord() : (recordFor(sender) ?? focusedRecord());
      if (
        record?.kind === "artifact" &&
        record.projectId !== undefined &&
        record.artifact !== undefined
      ) {
        return {
          kind: "artifact",
          projectId: record.projectId,
          artifact: record.artifact,
        };
      }
      if (record?.kind === "project" && record.projectId !== undefined) {
        return { kind: "project", projectId: record.projectId };
      }
      return { kind: "home", route: record?.route ?? "projects" };
    },
    sync: async (status) => {
      lastStatus = status;
      for (const record of records) await syncRecord(record, status);
    },
    hasFallback: () =>
      records.some((record) => !record.window.isDestroyed() && record.mode === "fallback"),
    openUi: async () => {
      show();
      const record = focusedRecord();
      if (record !== undefined) await syncRecordWithCurrentStatus(record);
    },
    retry: async () => {
      const status = await options.getStatus();
      lastStatus = status;
      for (const record of records) {
        if (record.mode === "fallback") {
          record.mode = "none";
          record.loadedKey = null;
        }
        await syncRecord(record, status);
      }
    },
    broadcastServiceStatus: (status) => {
      lastStatus = status;
      for (const record of records) {
        if (!record.window.isDestroyed()) {
          record.window.webContents.send(BRIDGE_CHANNELS.serviceStatusEvent, status);
        }
      }
    },
    broadcastUpdateStatus: (state) => {
      for (const record of records) {
        if (!record.window.isDestroyed()) {
          record.window.webContents.send(BRIDGE_CHANNELS.updateStatusEvent, state);
        }
      }
    },
    current: () => focusedRecord()?.window ?? records[0]?.window ?? null,
    beforeQuit: () => {
      quitting = true;
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      try {
        writeWindowSessionSync(config.userDataDir, sessionOf());
      } catch (cause) {
        logger.warn("could not save window session", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    hide: () => {
      for (const record of records) record.window.hide();
    },
    close: () => {
      for (const record of records) record.window.close();
    },
  };
}
