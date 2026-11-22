import { existsSync } from "node:fs";
import path from "node:path";
import type { AppUpdater, UpdateInfo } from "electron-updater";
import type { UpdateAction, UpdateState } from "../bridge.ts";
import type { Logger } from "./logger.ts";

export interface UpdateManagerOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly currentVersion: string;
  readonly feedUrl: string | undefined;
  readonly beforeInstall: () => Promise<void>;
  readonly logger: Logger;
  readonly onState: (state: UpdateState) => void;
}

export interface UpdateManager {
  status(): UpdateState;
  check(): Promise<UpdateState>;
  install(): Promise<UpdateAction>;
}

/**
 * Thin electron-updater wiring. The service is quiesced before quitAndInstall
 * (0003 §2 step 3); after relaunch the new app stages/hands off its service.
 *
 * Without a publish feed (local unsigned builds) this reports "unavailable"
 * rather than failing: the IPC contract stays the same when a real feed is
 * configured with BALLAST_UPDATE_URL at build time.
 */
export function createUpdateManager(options: UpdateManagerOptions): UpdateManager {
  let state: UpdateState = { phase: "idle", version: null, message: null };
  let updater: AppUpdater | null = null;

  const set = (next: UpdateState) => {
    state = next;
    options.onState(state);
  };

  const feedConfigured =
    options.feedUrl !== undefined || existsSync(path.join(options.resourcesPath, "app-update.yml"));

  const attach = (instance: AppUpdater): void => {
    instance.autoDownload = false;
    instance.autoInstallOnAppQuit = false;
    instance.on("update-available", (info: UpdateInfo) => {
      set({ phase: "available", version: info.version, message: "Update " + info.version + " is available" });
    });
    instance.on("update-not-available", () => {
      set({ phase: "unavailable", version: null, message: "Ballast is up to date (" + options.currentVersion + ")" });
    });
    instance.on("download-progress", (progress) => {
      set({
        phase: "downloading",
        version: state.version,
        message: Math.round(progress.percent) + "% downloaded",
      });
    });
    instance.on("update-downloaded", (info: UpdateInfo) => {
      set({ phase: "ready", version: info.version, message: "Update " + info.version + " is ready to install" });
    });
    instance.on("error", (cause: Error) => {
      options.logger.warn("update error", { message: cause.message });
      set({ phase: "error", version: state.version, message: cause.message });
    });
  };

  const load = async (): Promise<AppUpdater> => {
    if (updater === null) {
      const module = await import("electron-updater");
      updater = module.autoUpdater;
      attach(updater);
    }
    return updater;
  };

  return {
    status: () => state,

    async check() {
      if (!options.isPackaged) {
        set({ phase: "unavailable", version: null, message: "Updates are disabled in development builds" });
        return state;
      }
      if (!feedConfigured) {
        set({ phase: "unavailable", version: null, message: "No update feed is configured" });
        return state;
      }
      if (state.phase === "checking" || state.phase === "downloading" || state.phase === "ready") return state;

      set({ phase: "checking", version: null, message: "Checking for updates…" });
      try {
        const instance = await load();
        await instance.checkForUpdates();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        options.logger.warn("update check failed", { message });
        set({ phase: "error", version: null, message });
      }
      return state;
    },

    async install() {
      if (state.phase !== "ready") {
        return {
          ok: false,
          state,
          message: state.message ?? "No update has been downloaded yet",
        };
      }
      try {
        await options.beforeInstall();
        const instance = await load();
        set({ ...state, message: "Quitting to install update " + (state.version ?? "") });
        instance.quitAndInstall(false, true);
        return { ok: true, state, message: null };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        set({ phase: "error", version: state.version, message });
        return { ok: false, state, message };
      }
    },
  };
}
