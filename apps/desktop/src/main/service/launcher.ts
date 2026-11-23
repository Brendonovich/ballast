import path from "node:path";
import type { ServiceAction, ServicePermissions, ServicePhase, ServiceStatus } from "../../bridge.ts";
import type { DesktopConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { reportServicePermission, requestServiceShutdown } from "./controls.ts";
import { isProcessAlive, killProcess, spawnServiceProcess, terminateProcess } from "./process.ts";
import { adoptService } from "./registration.ts";
import { cleanStages, existingStage, resolveServiceBuild, stageService } from "./stage.ts";
import type { AdoptedService, ServiceBuild, Stage } from "./types.ts";

const STOP_TIMEOUT_MS = 7_000;
const KILL_TIMEOUT_MS = 3_000;
const POLL_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface LauncherOptions {
  readonly logger?: Logger;
  readonly spawn?: typeof spawnServiceProcess;
  /** Shell permissions, owned by Electron (see permissions.ts). */
  readonly permissions?: () => ServicePermissions;
}

/**
 * Owns the background service as a plain detached process (0003 §2): there is
 * no login item or OS supervisor. `start` adopts a running service of the
 * shipped version, replaces one of any other version, or spawns a new one;
 * `restart` is stop + spawn. The service outlives the UI.
 */
export interface ServiceLauncher {
  status(): Promise<ServiceStatus>;
  start(): Promise<ServiceAction>;
  stop(): Promise<ServiceAction>;
  restart(): Promise<ServiceAction>;
  /** Copy the shipped service stage and remove stages nothing references. */
  prepare(): Promise<void>;
  /** Stop the service before electron-updater replaces the app bundle; the relaunched app starts it again. */
  prepareForAppUpdate(): Promise<void>;
  /** Push shell permissions (macOS Accessibility) to a running service. */
  reportPermissions(): Promise<void>;
  /** Token-bearing connection details for the main process only. */
  getConnection(): Promise<{ readonly url: string; readonly token: string } | null>;
}

const adoptedPid = (adopted: AdoptedService): number => adopted.health.pid ?? adopted.registration.pid;

class Launcher implements ServiceLauncher {
  readonly config: DesktopConfig;
  readonly #logger: Logger;
  readonly #spawn: typeof spawnServiceProcess;
  readonly #permissions: () => ServicePermissions;
  #reportedPermission: {
    readonly pid: number;
    readonly accessibility: ServicePermissions["accessibility"];
  } | null = null;
  #busy: ServicePhase | null = null;
  #lastError: string | null = null;
  #buildPromise: Promise<ServiceBuild> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: DesktopConfig, options: LauncherOptions = {}) {
    this.config = config;
    this.#logger = options.logger ?? createLogger(config.logDir);
    this.#spawn = options.spawn ?? spawnServiceProcess;
    this.#permissions = options.permissions ?? (() => ({ accessibility: "unknown" }));
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #action(phase: ServicePhase, work: () => Promise<string>): Promise<ServiceAction> {
    return this.#enqueue(async () => {
      this.#busy = phase;
      this.#lastError = null;
      let ok = true;
      let message: string | null = null;
      try {
        message = await work();
      } catch (cause) {
        ok = false;
        message = errorMessage(cause);
        this.#lastError = message;
        this.#logger.error("service action failed", { phase, message });
      } finally {
        this.#busy = null;
      }
      return { ok, message, status: await this.status() };
    });
  }

  #build(): Promise<ServiceBuild> {
    if (this.#buildPromise === null) {
      this.#buildPromise = resolveServiceBuild(this.config).catch((cause: unknown) => {
        this.#buildPromise = null;
        throw cause;
      });
    }
    return this.#buildPromise;
  }

  #builtVersion(): Promise<string | null> {
    return this.#build().then(
      (build) => build.version,
      () => null,
    );
  }

  async status(): Promise<ServiceStatus> {
    const [adopted, builtVersion] = await Promise.all([adoptService(this.config), this.#builtVersion()]);
    const running = adopted?.compatible === true;
    const runningVersion = running ? adopted.registration.version : null;
    const updateAvailable = builtVersion !== null && runningVersion !== null && builtVersion !== runningVersion;
    const phase: ServicePhase =
      this.#busy ?? (running ? "running" : this.#lastError !== null ? "error" : "stopped");

    return {
      schemaVersion: 1,
      phase,
      running,
      builtVersion,
      runningVersion,
      apiVersion: running ? (adopted.health.apiVersion ?? adopted.registration.apiVersion) : null,
      pid: running ? adoptedPid(adopted) : null,
      url: running ? new URL(adopted.registration.url).origin : null,
      startedAt: running ? adopted.registration.startedAt : null,
      pendingConsents: running ? adopted.health.pendingConsents : null,
      updateAvailable,
      lastError: this.#lastError,
      permissions: this.#permissions(),
      paths: {
        userDataDir: this.config.userDataDir,
        stageRoot: this.config.stageRoot,
        stateDir: this.config.stateDir,
        dataDir: this.config.dataDir,
        logDir: this.config.logDir,
      },
    };
  }

  async getConnection(): Promise<{ readonly url: string; readonly token: string } | null> {
    const adopted = await adoptService(this.config);
    if (adopted === undefined || !adopted.compatible) return null;
    return { url: new URL(adopted.registration.url).origin, token: adopted.registration.token };
  }

  async reportPermissions(): Promise<void> {
    const adopted = await adoptService(this.config);
    if (adopted === undefined || !adopted.compatible) {
      this.#reportedPermission = null;
      return;
    }
    const pid = adoptedPid(adopted);
    const current = this.#permissions().accessibility;
    if (this.#reportedPermission?.pid === pid && this.#reportedPermission.accessibility === current) {
      return;
    }
    const reported = await reportServicePermission(adopted.registration, current);
    if (reported) {
      this.#reportedPermission = { pid, accessibility: current };
    }
  }

  async prepare(): Promise<void> {
    try {
      const build = await this.#build();
      await stageService(this.config, build);
      const adopted = await adoptService(this.config);
      const keep = new Set<string>([build.version]);
      if (adopted !== undefined) keep.add(adopted.registration.version);
      const removed = await cleanStages(this.config, [...keep]);
      this.#logger.info("service stages prepared", { build: build.version, kept: [...keep], removed });
    } catch (cause) {
      this.#lastError = errorMessage(cause);
      this.#logger.error("failed to prepare service stages", { message: this.#lastError });
    }
  }

  start(): Promise<ServiceAction> {
    return this.#action("starting", async () => {
      const stage = await stageService(this.config, await this.#build());
      const adopted = await adoptService(this.config);
      if (adopted?.compatible === true) {
        if (adopted.registration.version === stage.version) {
          return "service " + stage.version + " is already running";
        }
        return this.#replace(adopted, stage);
      }
      if (adopted !== undefined) await this.#stopNow();
      await this.#startNow(stage);
      return "service " + stage.version + " started";
    });
  }

  stop(): Promise<ServiceAction> {
    return this.#action("stopping", async () => {
      await this.#stopNow();
      return "service stopped";
    });
  }

  restart(): Promise<ServiceAction> {
    return this.#action("restarting", async () => {
      const stage = await stageService(this.config, await this.#build());
      const adopted = await adoptService(this.config);
      if (adopted === undefined) {
        await this.#startNow(stage);
        return "service " + stage.version + " started (it was not running)";
      }
      const oldPid = adoptedPid(adopted);
      await this.#stopNow();
      const restarted = await this.#startNow(stage);
      return "service restarted (old pid " + oldPid + " -> new pid " + adoptedPid(restarted) + ")";
    });
  }

  async prepareForAppUpdate(): Promise<void> {
    if ((await adoptService(this.config)) === undefined) return;
    await this.#enqueue(() => this.#stopNow());
  }

  /** Swap a running service of another version for `stage`, rolling back on failure. */
  async #replace(adopted: AdoptedService, stage: Stage): Promise<string> {
    this.#busy = "updating";
    const previousVersion = adopted.registration.version;
    const previous = await existingStage(this.config, previousVersion);
    this.#logger.info("replacing background service", { from: previousVersion, to: stage.version });
    await this.#stopNow();
    try {
      await this.#startNow(stage);
    } catch (cause) {
      if (previous === undefined) throw cause;
      this.#logger.warn("service update failed; restarting the previous version", {
        from: previousVersion,
        to: stage.version,
        message: errorMessage(cause),
      });
      await this.#stopNow().catch(() => undefined);
      await this.#startNow(previous);
      throw new Error(
        "service update to " + stage.version + " failed and was rolled back to " + previousVersion + ": " + errorMessage(cause),
      );
    }
    const removed = await cleanStages(this.config, [stage.version]);
    if (removed.length > 0) this.#logger.info("removed old service stages", { removed });
    return "service updated from " + previousVersion + " to " + stage.version;
  }

  async #startNow(stage: Stage): Promise<AdoptedService> {
    const child = await this.#spawn(this.config, stage);
    const running = await this.#waitForRunning({ version: stage.version, timeoutMs: this.config.startTimeoutMs });
    if (running === undefined) {
      // Don't leave a half-started process behind to fight the next attempt.
      if (child.pid !== undefined) killProcess(child.pid);
      throw new Error(
        "service " + stage.version + " did not answer /health within " + this.config.startTimeoutMs + "ms (see " +
          path.join(this.config.logDir, "service.err.log") + ")",
      );
    }
    return running;
  }

  async #stopNow(): Promise<void> {
    const adopted = await adoptService(this.config);
    if (adopted === undefined) return;
    const pid = adoptedPid(adopted);
    if (adopted.compatible && (await requestServiceShutdown(adopted.registration))) {
      await this.#waitForExit(pid, STOP_TIMEOUT_MS);
    }
    if (isProcessAlive(pid)) {
      terminateProcess(pid);
      await this.#waitForExit(pid, STOP_TIMEOUT_MS);
    }
    if (isProcessAlive(pid)) {
      this.#logger.warn("service did not exit after SIGTERM; killing it", { pid });
      killProcess(pid);
      await this.#waitForExit(pid, KILL_TIMEOUT_MS);
    }
    if (isProcessAlive(pid)) throw new Error("service process " + pid + " did not exit");
  }

  async #waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isProcessAlive(pid)) await delay(POLL_MS);
  }

  async #waitForRunning(options: {
    readonly version: string;
    readonly timeoutMs: number;
  }): Promise<AdoptedService | undefined> {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const adopted = await adoptService(this.config);
      if (adopted !== undefined && adopted.compatible && adopted.registration.version === options.version) {
        return adopted;
      }
      await delay(POLL_MS);
    }
    return undefined;
  }
}

export function createServiceLauncher(config: DesktopConfig, options: LauncherOptions = {}): ServiceLauncher {
  return new Launcher(config, options);
}
