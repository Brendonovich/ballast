import path from "node:path";
import type { ServiceAction, ServicePhase, ServiceStatus, ServiceSupervisorKind } from "../../bridge.ts";
import type { DesktopConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { requestServiceControl } from "./controls.ts";
import {
  initialHandoffState,
  transition,
  type HandoffCommand,
  type HandoffEvent,
  type HandoffState,
} from "./handoff.ts";
import { isProcessAlive, spawnServiceProcess, terminateProcess } from "./process.ts";
import { adoptService } from "./registration.ts";
import { createServiceRuntime, type ServiceRuntime } from "./runtime.ts";
import {
  asStage,
  cleanStages,
  readInstalledStage,
  removeInstalledStage,
  resolveServiceBuild,
  stageRef,
  stageService,
  writeInstalledStage,
} from "./stage.ts";
import type { AdoptedService, ServiceBuild, Stage, StageRef } from "./types.ts";

const STOP_TIMEOUT_MS = 7_000;
const POLL_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface LauncherOptions {
  readonly runtime?: ServiceRuntime | null;
  readonly logger?: Logger;
  readonly spawn?: typeof spawnServiceProcess;
}

export interface ServiceLauncher {
  status(): Promise<ServiceStatus>;
  install(): Promise<ServiceAction>;
  uninstall(): Promise<ServiceAction>;
  start(): Promise<ServiceAction>;
  stop(): Promise<ServiceAction>;
  restart(): Promise<ServiceAction>;
  /** Copy the shipped service stage and remove unreferenced old stages. */
  prepare(): Promise<void>;
  /** Quiesce the installed service before electron-updater replaces the app bundle (0003 §2). */
  prepareForAppUpdate(): Promise<void>;
  /** Token-bearing connection details for the main process only. */
  getConnection(): Promise<{ readonly url: string; readonly token: string } | null>;
}

class Launcher implements ServiceLauncher {
  readonly config: DesktopConfig;
  readonly #runtime: ServiceRuntime | null;
  readonly #logger: Logger;
  readonly #spawn: typeof spawnServiceProcess;
  #busy: ServicePhase | null = null;
  #lastError: string | null = null;
  #buildPromise: Promise<ServiceBuild> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: DesktopConfig, options: LauncherOptions = {}) {
    this.config = config;
    this.#runtime = options.runtime === undefined ? createServiceRuntime(config) : options.runtime;
    this.#logger = options.logger ?? createLogger(config.logDir);
    this.#spawn = options.spawn ?? spawnServiceProcess;
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

  async #isInstalled(): Promise<boolean> {
    if (this.#runtime === null) return false;
    try {
      return await this.#runtime.isInstalled();
    } catch {
      return false;
    }
  }

  get #supervisor(): ServiceSupervisorKind {
    return this.#runtime?.kind ?? "process";
  }

  async status(): Promise<ServiceStatus> {
    const [installed, installedStage, adopted, builtVersion] = await Promise.all([
      this.#isInstalled(),
      readInstalledStage(this.config).catch(() => undefined),
      adoptService(this.config),
      this.#builtVersion(),
    ]);
    const running = adopted?.compatible === true;
    const runningVersion = running ? adopted.registration.version : null;
    const installedVersion = installedStage?.version ?? null;
    const compareVersion = runningVersion ?? installedVersion;
    const updateAvailable =
      builtVersion !== null && compareVersion !== null && builtVersion !== compareVersion;

    let phase: ServicePhase = this.#busy ?? (running ? "running" : installed ? "installed" : "not-installed");
    if (this.#busy === null && this.#lastError !== null && !running && installed) phase = "error";

    return {
      schemaVersion: 1,
      phase,
      installed,
      running,
      supervisor: this.#supervisor,
      loginItemPath: this.#runtime?.loginItemPath ?? null,
      installedVersion,
      builtVersion,
      runningVersion,
      apiVersion: running ? (adopted.health.apiVersion ?? adopted.registration.apiVersion) : null,
      pid: running ? (adopted.health.pid ?? adopted.registration.pid) : null,
      url: running ? new URL(adopted.registration.url).origin : null,
      startedAt: running ? adopted.registration.startedAt : null,
      pendingConsents: running ? adopted.health.pendingConsents : null,
      updateAvailable,
      lastError: this.#lastError,
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

  async prepare(): Promise<void> {
    try {
      const build = await this.#build();
      await stageService(this.config, build);
      const [installedStage, adopted] = await Promise.all([
        readInstalledStage(this.config).catch(() => undefined),
        adoptService(this.config),
      ]);
      const keep = new Set<string>([build.version]);
      if (installedStage !== undefined) keep.add(installedStage.version);
      if (adopted !== undefined) keep.add(adopted.registration.version);
      const removed = await cleanStages(this.config, [...keep]);
      this.#logger.info("service stages prepared", { build: build.version, kept: [...keep], removed });
    } catch (cause) {
      this.#lastError = errorMessage(cause);
      this.#logger.error("failed to prepare service stages", { message: this.#lastError });
    }
  }

  install(): Promise<ServiceAction> {
    return this.#action("installing", async () => {
      const build = await this.#build();
      const target = stageRef(this.config.stageRoot, build.version);
      const [installed, installedStage, adopted] = await Promise.all([
        this.#isInstalled(),
        readInstalledStage(this.config).catch(() => undefined),
        adoptService(this.config),
      ]);

      if (!installed && adopted?.compatible) {
        // A development service is running without a login item; stop it before
        // launchd/task takes over the same state directory.
        await this.#stopNow();
      }

      const previous =
        installedStage ?? (adopted === undefined ? null : stageRef(this.config.stageRoot, adopted.registration.version));

      if (installed && previous !== null && previous.version === target.version && adopted?.compatible) {
        return "service " + target.version + " is already installed and running";
      }

      const event: HandoffEvent =
        installed && previous !== null
          ? { type: "update.requested", target, previous }
          : { type: "install.requested", target };
      const state = await this.#runHandoff(event);
      return this.#finishHandoff(state);
    });
  }

  start(): Promise<ServiceAction> {
    return this.#action("starting", async () => {
      const [installed, installedStage, adopted, build] = await Promise.all([
        this.#isInstalled(),
        readInstalledStage(this.config).catch(() => undefined),
        adoptService(this.config),
        this.#build(),
      ]);
      const stage = installed && installedStage !== undefined ? asStage(installedStage) : await stageService(this.config, build);
      if (adopted?.compatible && adopted.registration.version === stage.version) {
        return "service " + stage.version + " is already running";
      }
      await this.#startNow(stage, installed);
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
      const adopted = await adoptService(this.config);
      if (adopted === undefined || !adopted.compatible) {
        const [installed, installedStage, build] = await Promise.all([
          this.#isInstalled(),
          readInstalledStage(this.config).catch(() => undefined),
          this.#build(),
        ]);
        const stage = installed && installedStage !== undefined ? asStage(installedStage) : await stageService(this.config, build);
        await this.#startNow(stage, installed);
        return "service started (it was not running)";
      }

      const oldPid = adopted.health.pid ?? adopted.registration.pid;
      const asked = await requestServiceControl(adopted.registration, "restart");
      if (asked) {
        const restarted = await this.#waitForRunning({ pidNot: oldPid, timeoutMs: this.config.startTimeoutMs });
        if (restarted !== undefined) return "service restarted (old pid " + oldPid + " -> new pid " + (restarted.health.pid ?? restarted.registration.pid) + ")";
        this.#logger.warn("service did not come back after exit 75; asking the supervisor");
      }

      const installed = await this.#isInstalled();
      if (installed && this.#runtime !== null) {
        await this.#runtime.restart();
      } else {
        const [installedStage, build] = await Promise.all([
          readInstalledStage(this.config).catch(() => undefined),
          this.#build(),
        ]);
        terminateProcess(oldPid);
        await this.#waitForHealthDown(STOP_TIMEOUT_MS);
        const stage = installedStage !== undefined ? asStage(installedStage) : await stageService(this.config, build);
        await this.#startNow(stage, false);
      }

      const restarted = await this.#waitForRunning({ pidNot: oldPid, timeoutMs: this.config.startTimeoutMs });
      if (restarted === undefined) throw new Error("service did not restart within " + this.config.startTimeoutMs + "ms");
      return "service restarted (old pid " + oldPid + " -> new pid " + (restarted.health.pid ?? restarted.registration.pid) + ")";
    });
  }

  uninstall(): Promise<ServiceAction> {
    return this.#action("uninstalling", async () => {
      const previous = (await readInstalledStage(this.config).catch(() => undefined)) ?? null;
      if (this.#runtime === null) {
        await this.#stopNow();
        await removeInstalledStage(this.config);
        return "service stopped (this platform has no login item)";
      }
      const state = await this.#runHandoff({ type: "uninstall.requested", previous });
      return this.#finishHandoff(state);
    });
  }

  async prepareForAppUpdate(): Promise<void> {
    if ((await adoptService(this.config)) === undefined) return;
    await this.#enqueue(async () => {
      await this.#stopNow();
    });
  }

  async #startNow(stage: Stage, installed: boolean): Promise<void> {
    if (installed && this.#runtime !== null) await this.#runtime.start();
    else await this.#spawn(this.config, stage);
    const running = await this.#waitForRunning({ version: stage.version, timeoutMs: this.config.startTimeoutMs });
    if (running === undefined) {
      throw new Error(
        "service " + stage.version + " did not answer /health within " + this.config.startTimeoutMs + "ms (see " +
          path.join(this.config.logDir, "service.err.log") + ")",
      );
    }
  }

  async #stopNow(): Promise<void> {
    const adopted = await adoptService(this.config);
    const pid = adopted === undefined ? undefined : (adopted.health.pid ?? adopted.registration.pid);
    if (adopted !== undefined) {
      await requestServiceControl(adopted.registration, "shutdown");
      await this.#waitForHealthDown(5_000);
    }

    const installed = await this.#isInstalled();
    if (installed && this.#runtime !== null) await this.#runtime.stop();
    if (pid !== undefined) terminateProcess(pid);

    await this.#waitForHealthDown(STOP_TIMEOUT_MS);
    if (pid !== undefined) {
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline && isProcessAlive(pid)) await delay(POLL_MS);
      if (isProcessAlive(pid)) throw new Error("service process " + pid + " did not exit");
    }
    if ((await adoptService(this.config))?.compatible === true) {
      throw new Error("service is still answering /health after stop");
    }
  }

  async #waitForHealthDown(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await adoptService(this.config)) === undefined) return;
      await delay(POLL_MS);
    }
  }

  async #waitForRunning(options: {
    readonly version?: string;
    readonly pidNot?: number;
    readonly timeoutMs: number;
  }): Promise<AdoptedService | undefined> {
    const deadline = Date.now() + options.timeoutMs;
    const pidNot = options.pidNot;
    while (Date.now() < deadline) {
      const adopted = await adoptService(this.config);
      const pid = adopted === undefined ? null : (adopted.health.pid ?? adopted.registration.pid);
      if (
        adopted !== undefined &&
        adopted.compatible &&
        (options.version === undefined || adopted.registration.version === options.version) &&
        (pidNot === undefined || pid !== pidNot)
      ) {
        return adopted;
      }
      await delay(POLL_MS);
    }
    return undefined;
  }

  async #runHandoff(event: HandoffEvent): Promise<HandoffState> {
    let result = transition(initialHandoffState, event);
    let state = result.state;
    const queue: HandoffCommand[] = [...result.commands];

    while (queue.length > 0) {
      const command = queue.shift();
      if (command === undefined) break;
      try {
        await this.#execute(command);
        result = transition(state, { type: "step.succeeded", step: command.step });
      } catch (cause) {
        const failure = errorMessage(cause);
        this.#logger.warn("handoff step failed", { step: command.step, failure });
        result = transition(state, { type: "step.failed", step: command.step, failure });
      }
      state = result.state;
      queue.push(...result.commands);
    }

    return state;
  }

  async #execute(command: HandoffCommand): Promise<void> {
    switch (command.type) {
      case "stage": {
        const build = await this.#build();
        if (build.version !== command.target.version) {
          throw new Error("service build changed during handoff: " + build.version + " != " + command.target.version);
        }
        await stageService(this.config, build);
        return;
      }
      case "stop":
        await this.#stopNow();
        return;
      case "write-login-item":
        if (this.#runtime === null) throw new Error("no login-item supervisor on " + this.config.platform);
        await this.#runtime.install(asStage(command.target));
        return;
      case "start": {
        const installed = await this.#isInstalled();
        await this.#startNow(asStage(command.target), installed);
        return;
      }
      case "verify": {
        const adopted = await this.#waitForRunning({ version: command.target.version, timeoutMs: this.config.startTimeoutMs });
        if (adopted === undefined) throw new Error("service " + command.target.version + " did not answer /health");
        return;
      }
      case "clean-stages": {
        const removed = await cleanStages(this.config, command.keep);
        if (removed.length > 0) this.#logger.info("removed old service stages", { removed });
        return;
      }
      case "remove-login-item":
        if (this.#runtime !== null) await this.#runtime.uninstall();
        return;
    }
  }

  async #finishHandoff(state: HandoffState): Promise<string> {
    if (state.kind === "failed") {
      throw new Error(state.operation + " failed at " + state.step + ": " + state.failure);
    }
    if (state.kind !== "done") throw new Error("handoff did not finish");

    if (state.active !== null) await writeInstalledStage(this.config, state.active);
    else await removeInstalledStage(this.config);

    if (state.rolledBack) {
      throw new Error(
        "service update failed and was rolled back to " +
          (state.active === null ? "none" : state.active.version) +
          ": " +
          (state.failure ?? "unknown error"),
      );
    }
    if (state.failure !== null) {
      const activeIsPrevious =
        state.active !== null && state.previous !== null && state.active.version === state.previous.version;
      if (state.active === null || activeIsPrevious) {
        throw new Error(state.operation + " failed: " + state.failure);
      }
      this.#logger.warn("service cleanup failed after a successful handoff", { failure: state.failure });
    }

    if (state.operation === "uninstall") return "service stopped and login item removed";
    if (state.operation === "update") return "service updated to " + (state.active?.version ?? "unknown");
    return "service " + (state.active?.version ?? "unknown") + " installed and started";
  }
}

export function createServiceLauncher(config: DesktopConfig, options: LauncherOptions = {}): ServiceLauncher {
  return new Launcher(config, options);
}

export type { StageRef };
