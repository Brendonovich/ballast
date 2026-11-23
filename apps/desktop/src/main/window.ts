import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_CHANNELS, type ServiceStatus, type UpdateState } from "../bridge.ts";
import type { DesktopConfig } from "./config.ts";
import type { Logger } from "./logger.ts";

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
}

export interface WindowController {
  show(): void;
  hide(): void;
  close(): void;
  /** Navigate to the service/dev UI when appropriate and mirror status to renderers. */
  sync(status: ServiceStatus): Promise<void>;
  openUi(): Promise<void>;
  retry(): Promise<void>;
  broadcastServiceStatus(status: ServiceStatus): void;
  broadcastUpdateStatus(state: UpdateState): void;
  current(): BrowserWindow | null;
}

const isHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export function createWindowController(options: WindowControllerOptions): WindowController {
  const { config, logger } = options;
  let win: BrowserWindow | null = null;
  let mode: WindowMode = "none";
  let loadedOrigin: string | null = null;
  let loadedPid: number | null = null;
  let lastStatus: ServiceStatus | null = null;

  const secure = (created: BrowserWindow) => {
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith("file:")) {
        event.preventDefault();
        return;
      }
      if (loadedOrigin !== null && isHttpUrl(url) && new URL(url).origin === loadedOrigin) return;
      if (isHttpUrl(url)) {
        event.preventDefault();
        void shell.openExternal(url);
      } else {
        event.preventDefault();
      }
    });
    created.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications"]);
    const trustedPage = (contents: Electron.WebContents): boolean => {
      try {
        const url = new URL(contents.getURL());
        return url.protocol === "http:" || url.protocol === "https:";
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
    created.webContents.on("did-fail-load", (_event, errorCode, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      logger.warn("window failed to load", { errorCode, description, url: failedUrl.replace(/token=[^&]+/, "token=[redacted]") });
      void loadFallback(created);
    });
    created.webContents.on("render-process-gone", (_event, details) => {
      logger.error("renderer process gone", { reason: details.reason });
      void loadFallback(created);
    });
  };

  const create = (): BrowserWindow => {
    const created = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: "Ballast",
      backgroundColor: "#0b0d10",
      autoHideMenuBar: process.platform !== "darwin",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    secure(created);
    created.once("ready-to-show", () => {
      if (!created.isDestroyed()) created.show();
    });
    created.on("closed", () => {
      win = null;
      mode = "none";
      loadedOrigin = null;
      loadedPid = null;
    });
    return created;
  };

  const loadFallback = async (target: BrowserWindow): Promise<void> => {
    if (target.isDestroyed()) return;
    if (mode === "fallback") return;
    mode = "fallback";
    loadedOrigin = null;
    loadedPid = null;
    try {
      await target.loadFile(fallbackPath);
    } catch (cause) {
      logger.error("failed to load fallback page", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const loadService = async (target: BrowserWindow, connection: WindowConnection, status: ServiceStatus): Promise<void> => {
    if (target.isDestroyed()) return;
    const url = new URL("/", connection.url);
    // The service validates this token, sets an HttpOnly SameSite=Strict cookie
    // and redirects to /. The token never enters the UI or its JS (0003 §2).
    url.searchParams.set("token", connection.token);
    mode = "service";
    loadedOrigin = connection.url;
    loadedPid = status.pid;
    try {
      await target.loadURL(url.toString());
    } catch (cause) {
      logger.warn("failed to load service UI", {
        origin: connection.url,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      await loadFallback(target);
    }
  };

  const sync = async (status: ServiceStatus): Promise<void> => {
    lastStatus = status;
    const target = win;
    if (target === null || target.isDestroyed()) return;

    if (config.uiUrl !== undefined) {
      if (mode !== "dev") {
        mode = "dev";
        loadedOrigin = new URL(config.uiUrl).origin;
        loadedPid = null;
        try {
          await target.loadURL(config.uiUrl);
        } catch (cause) {
          logger.warn("failed to load BALLAST_UI_URL", {
            message: cause instanceof Error ? cause.message : String(cause),
          });
          await loadFallback(target);
        }
      }
      return;
    }

    if (!status.running || status.url === null) {
      // Nothing to load yet: show the bundled "Starting Ballast…" page instead
      // of leaving the new window on about:blank. loadFallback is a no-op once
      // the page is already showing.
      await loadFallback(target);
      return;
    }

    if (mode === "service" && loadedOrigin === status.url && loadedPid === status.pid) return;
    const connection = await options.getConnection();
    if (connection === null) {
      await loadFallback(target);
      return;
    }
    await loadService(target, connection, status);
  };

  const show = (): void => {
    if (win !== null && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = create();
    void (async () => {
      const status = lastStatus ?? (await options.getStatus());
      await sync(status);
    })();
  };

  return {
    show,
    hide: () => win?.hide(),
    close: () => win?.close(),
    sync,
    openUi: async () => {
      const status = await options.getStatus();
      if (win === null || win.isDestroyed()) show();
      await sync(status);
    },
    retry: async () => {
      const status = await options.getStatus();
      if (win === null || win.isDestroyed()) show();
      if (!status.running && mode === "fallback" && win !== null) {
        mode = "none";
        await loadFallback(win);
        return;
      }
      await sync(status);
    },
    broadcastServiceStatus: (status) => {
      lastStatus = status;
      if (win !== null && !win.isDestroyed()) win.webContents.send(BRIDGE_CHANNELS.serviceStatusEvent, status);
    },
    broadcastUpdateStatus: (state) => {
      if (win !== null && !win.isDestroyed()) win.webContents.send(BRIDGE_CHANNELS.updateStatusEvent, state);
    },
    current: () => win,
  };
}
