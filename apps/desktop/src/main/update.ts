import path from "node:path";
import type { UpdateAction, UpdateState } from "../bridge.ts";
import type { Logger } from "./logger.ts";
import { downloadTarget } from "./update/download.ts";
import {
  APP,
  ARTIFACT,
  detectInstallMethod,
  readBuildRelease,
  readRolloutBucket,
  targetsFor,
  type Channel,
  type InstallMethod,
  type Targets,
} from "./update/install.ts";
import type { PlatformInstaller } from "./update/platform.ts";
import { decide, type Decision } from "./update/protocol.ts";

export interface UpdateManagerOptions {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly userDataDir: string;
  readonly currentVersion: string;
  /** BALLAST_RELEASE_URL: overrides the stamped release service, to rehearse against a local or dev one. */
  readonly origin: string | undefined;
  readonly installer: PlatformInstaller | undefined;
  readonly openExternal: (url: string) => Promise<void>;
  readonly beforeInstall: () => Promise<void>;
  readonly logger: Logger;
  readonly onState: (state: UpdateState) => void;
  /** Overrides for tests. */
  readonly installMethod?: InstallMethod;
  readonly rolloutBucket?: number;
  readonly fetch?: typeof fetch;
}

export interface UpdateManager {
  status(): UpdateState;
  check(): Promise<UpdateState>;
  install(): Promise<UpdateAction>;
  /** Check now and then on a schedule: hourly, or every 10 minutes on dev. */
  startSchedule(): void;
  stopSchedule(): void;
}

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
const DEV_CHECK_INTERVAL_MS = 10 * 60_000;

type Offer =
  /** Ballast installs this itself; `file` once it is downloaded and staged. */
  | {
      readonly kind: "install";
      readonly decision: Extract<Decision, { action: "install" }>;
      file: string | null;
    }
  /** Ballast can't install it; the user downloads it. */
  | { readonly kind: "download"; readonly version: string; readonly url: string };

/**
 * Updates from Ballast's release service (apps/release, the anomalyco/release
 * protocol; the build stamps its URL), following its client rules (update/protocol.ts): the channel's current release is the one
 * to run, whatever its version. A direct install downloads the target,
 * verifies its size and SHA-256, and stages it; Install quits into it
 * (update/platform.ts). Builds without a release stamp (development, local
 * pack) never check.
 */
export function createUpdateManager(options: UpdateManagerOptions): UpdateManager {
  let state: UpdateState = { phase: "idle", version: null, message: null };
  let offer: Offer | null = null;
  let busy: Promise<UpdateState> | null = null;
  let timer: NodeJS.Timeout | undefined;
  let etag: string | null = null;
  let manifestText: string | null = null;

  const set = (next: UpdateState): UpdateState => {
    state = next;
    options.onState(state);
    return state;
  };

  const build = options.isPackaged ? readBuildRelease(options.appPath) : undefined;
  const buildChannel = build?.channel;
  const targets: Targets | undefined = targetsFor(options.platform, options.arch);
  const origin = (options.origin ?? build?.origin ?? "").replace(/\/+$/, "");

  const disabledReason = (): string | null => {
    if (!options.isPackaged) return "Updates are disabled in development builds";
    if (buildChannel === undefined) return "This build has no release channel, so it does not update";
    if (targets === undefined) return "Updates are not available for " + options.platform + "-" + options.arch;
    return null;
  };

  const method = (channel: Channel): InstallMethod =>
    options.installMethod ??
    detectInstallMethod({ platform: options.platform, execPath: options.execPath, buildChannel: channel });

  const userAgent = (channel: Channel) => APP + "/" + channel + "/" + options.currentVersion;

  const fetchManifest = async (channel: Channel): Promise<string> => {
    const headers: Record<string, string> = { "User-Agent": userAgent(channel) };
    if (etag !== null && manifestText !== null) headers["If-None-Match"] = etag;
    const response = await (options.fetch ?? fetch)(origin + "/" + APP + "/" + ARTIFACT + "/" + channel + ".json", {
      headers,
    });
    if (response.status === 304 && manifestText !== null) return manifestText;
    if (!response.ok) throw new Error("update check failed: HTTP " + response.status);
    manifestText = await response.text();
    etag = response.headers.get("etag");
    return manifestText;
  };

  const downloadLink = (channel: Channel, target: string) =>
    origin + "/" + APP + "/" + ARTIFACT + "/" + channel + "/" + target;

  const stage = async (current: Offer & { kind: "install" }) => {
    const { decision } = current;
    const url = new URL(decision.target.url, origin + "/").href;
    const file = await downloadTarget({
      url,
      target: decision.target,
      dir: path.join(options.userDataDir, "updates"),
      userAgent: userAgent(buildChannel ?? "stable"),
      fetch: options.fetch ?? fetch,
      onProgress: (received, total) => {
        set({
          phase: "downloading",
          version: decision.version,
          message: "Downloading Ballast " + decision.version + " (" + Math.floor((received / total) * 100) + "%)",
        });
      },
    });
    await options.installer?.prepare(file);
    current.file = file;
    set({ phase: "ready", version: decision.version, message: "Ballast " + decision.version + " is ready to install" });
    return file;
  };

  const runCheck = async (): Promise<UpdateState> => {
    const disabled = disabledReason();
    if (disabled !== null || buildChannel === undefined || targets === undefined) {
      return set({ phase: "unavailable", version: null, message: disabled });
    }
    const install = method(buildChannel);
    const expected = install.channel;
    if (state.phase !== "ready") set({ phase: "checking", version: null, message: "Checking for updates…" });
    try {
      const decision = decide({
        app: APP,
        artifact: ARTIFACT,
        channel: expected,
        manifest: await fetchManifest(expected),
        install: {
          version: options.currentVersion,
          target: targets.install,
          distribution: install.kind === "unknown" ? "unknown" : "direct",
          rollout_bucket: options.rolloutBucket ?? readRolloutBucket(options.userDataDir),
          channel: buildChannel,
        },
      });
      options.logger.info("update check", { channel: expected, method: install.kind, decision });

      if (decision.action === "reject") {
        return set({ phase: "error", version: null, message: "The update manifest was rejected (" + decision.reason + ")" });
      }
      if (decision.action === "none") {
        offer = null;
        return set({
          phase: "unavailable",
          version: null,
          message: "Ballast is up to date (" + options.currentVersion + ")",
        });
      }
      if (decision.action === "notify" || install.kind !== "direct" || options.installer === undefined) {
        const reason = install.kind === "download" ? install.reason : "Download it to update";
        offer = { kind: "download", version: decision.version, url: downloadLink(expected, targets.download) };
        return set({ phase: "available", version: decision.version, message: "Ballast " + decision.version + " is available. " + reason });
      }

      if (offer?.kind === "install" && offer.decision.target.sha256 === decision.target.sha256 && offer.file !== null) {
        return set({ phase: "ready", version: decision.version, message: "Ballast " + decision.version + " is ready to install" });
      }
      const current: Offer & { kind: "install" } = { kind: "install", decision, file: null };
      offer = current;
      // A channel switch is the user's choice: wait for Install before downloading.
      if (decision.reason === "switch") {
        return set({ phase: "available", version: decision.version, message: "Switch to Ballast " + decision.version + "?" });
      }
      await stage(current);
      return state;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.logger.warn("update check failed", { message });
      return set({ phase: "error", version: state.version, message });
    }
  };

  const check = (): Promise<UpdateState> => {
    if (busy === null) {
      busy = runCheck().finally(() => {
        busy = null;
      });
    }
    return busy;
  };

  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      void check().finally(() => {
        schedule(buildChannel === "dev" ? DEV_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS);
      });
    }, delay);
    timer.unref();
  };

  return {
    status: () => state,
    check,

    async install() {
      const current = offer;
      if (current === null) {
        return { ok: false, state, message: state.message ?? "No update is available" };
      }
      if (current.kind === "download") {
        await options.openExternal(current.url);
        return { ok: true, state, message: null };
      }
      try {
        if (busy !== null) await busy;
        // An offered switch downloads once the user chooses it.
        const file = current.file ?? (await stage(current));
        await options.beforeInstall();
        set({ ...state, message: "Quitting to install Ballast " + current.decision.version });
        options.installer?.install(file);
        return { ok: true, state, message: null };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        set({ phase: "error", version: state.version, message });
        return { ok: false, state, message };
      }
    },

    startSchedule() {
      if (disabledReason() !== null) {
        set({ phase: "unavailable", version: null, message: disabledReason() });
        return;
      }
      if (timer === undefined) schedule(STARTUP_DELAY_MS);
    },

    stopSchedule() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
