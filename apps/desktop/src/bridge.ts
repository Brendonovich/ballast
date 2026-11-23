// The typed contract between the Electron main process and the renderer,
// exposed by the preload script as `window.ballast`.
//
// This file has no imports and no Electron dependency, so the web app can use
// it type-only:
//
//   import type { BallastBridge, ServiceStatus } from "@ballast/desktop/bridge";
//
// (or a relative `../../apps/desktop/src/bridge.ts` import while apps/web is
// not yet a workspace dependency of @ballast/desktop). No service token is ever
// part of this contract.

export const BRIDGE_VERSION = 1 as const;

export const BRIDGE_CHANNELS = {
  serviceStatus: "ballast:service:status",
  serviceInstall: "ballast:service:install",
  serviceUninstall: "ballast:service:uninstall",
  serviceStart: "ballast:service:start",
  serviceStop: "ballast:service:stop",
  serviceRestart: "ballast:service:restart",
  permissionsStatus: "ballast:permissions:status",
  permissionsRequestAccessibility: "ballast:permissions:request-accessibility",
  updateStatus: "ballast:update:status",
  updateInstall: "ballast:update:install",
  appInfo: "ballast:app:info",
  appOpenUi: "ballast:app:open-ui",
  appRetry: "ballast:app:retry",
  appShowLogs: "ballast:app:show-logs",
  appOpenExternal: "ballast:app:open-external",
  serviceStatusEvent: "ballast:event:service-status",
  updateStatusEvent: "ballast:event:update-status",
} as const;

export type ServicePhase =
  | "not-installed"
  | "installed"
  | "starting"
  | "restarting"
  | "stopping"
  | "running"
  | "installing"
  | "updating"
  | "uninstalling"
  | "error";

/** Which OS supervisor owns (or would own) the service process. */
export type ServiceSupervisorKind = "launch-agent" | "scheduled-task" | "process" | "none";

/**
 * A shell-owned permission the agent cannot query itself.
 * On macOS, `accessibility` is `systemPreferences.isTrustedAccessibilityClient`;
 * Windows and Linux report `granted` because global input hooks need no extra grant.
 */
export type PermissionStatus = "granted" | "denied" | "unknown";

export interface ServicePermissions {
  readonly accessibility: PermissionStatus;
}

export interface ServicePaths {
  readonly userDataDir: string;
  readonly stageRoot: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly logDir: string;
}

export interface ServiceStatus {
  readonly schemaVersion: 1;
  readonly phase: ServicePhase;
  /** The login item is present on disk. */
  readonly installed: boolean;
  /** A compatible service answered `/health` during this status read. */
  readonly running: boolean;
  readonly supervisor: ServiceSupervisorKind;
  readonly loginItemPath: string | null;
  /** The stage the login item points at (written by the last successful install). */
  readonly installedVersion: string | null;
  /** The service build shipped with this app (or configured by env). */
  readonly builtVersion: string | null;
  readonly runningVersion: string | null;
  readonly apiVersion: number | null;
  readonly pid: number | null;
  readonly url: string | null;
  readonly startedAt: number | null;
  /** From `/health.scripts.needsConsent`; null when the service is not reachable. */
  readonly pendingConsents: number | null;
  readonly updateAvailable: boolean;
  readonly lastError: string | null;
  /** Shell permissions the background service needs (macOS Accessibility). */
  readonly permissions: ServicePermissions;
  readonly paths: ServicePaths;
}

export interface ServiceAction {
  readonly ok: boolean;
  readonly status: ServiceStatus;
  readonly message: string | null;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "unavailable";

export interface UpdateState {
  readonly phase: UpdatePhase;
  readonly version: string | null;
  readonly message: string | null;
}

export interface UpdateAction {
  readonly ok: boolean;
  readonly state: UpdateState;
  readonly message: string | null;
}

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly packaged: boolean;
}

/** The object exposed as `window.ballast` in every Ballast window. */
export interface BallastBridge {
  readonly version: typeof BRIDGE_VERSION;
  readonly service: {
    status(): Promise<ServiceStatus>;
    install(): Promise<ServiceAction>;
    uninstall(): Promise<ServiceAction>;
    start(): Promise<ServiceAction>;
    stop(): Promise<ServiceAction>;
    restart(): Promise<ServiceAction>;
  };
  readonly permissions: {
    /** Current shell permissions without prompting. */
    status(): Promise<ServicePermissions>;
    /**
     * Ask macOS to grant Accessibility: opens the system prompt or System
     * Settings, reports the result to the running service, and returns it.
     * A no-op returning `granted` on Windows and Linux.
     */
    requestAccessibility(): Promise<ServicePermissions>;
  };
  readonly update: {
    status(): Promise<UpdateState>;
    install(): Promise<UpdateAction>;
  };
  readonly app: {
    info(): Promise<AppInfo>;
    /** Ask main to navigate this window to the running service's UI. */
    openUi(): Promise<void>;
    /** Re-run discovery and navigate when the service is ready. */
    retry(): Promise<void>;
    showLogs(): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  readonly events: {
    onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
    onUpdateStatus(listener: (state: UpdateState) => void): () => void;
  };
}
