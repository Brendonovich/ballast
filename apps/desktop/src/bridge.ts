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

export const BRIDGE_VERSION = 2 as const;

export const BRIDGE_CHANNELS = {
  serviceStatus: "ballast:service:status",
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
  appPickDirectory: "ballast:app:pick-directory",
  windowsContext: "ballast:windows:context",
  windowsOpenProject: "ballast:windows:open-project",
  windowsOpenHome: "ballast:windows:open-home",
  projectsSetMenu: "ballast:projects:set-menu",
  serviceStatusEvent: "ballast:event:service-status",
  updateStatusEvent: "ballast:event:update-status",
} as const;

export type ServicePhase =
  | "stopped"
  | "starting"
  | "restarting"
  | "stopping"
  | "running"
  | "updating"
  | "error";

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
  /** A compatible service answered `/health` during this status read. */
  readonly running: boolean;
  /** The service build shipped with this app (or configured by env). */
  readonly builtVersion: string | null;
  readonly runningVersion: string | null;
  readonly apiVersion: number | null;
  readonly pid: number | null;
  readonly url: string | null;
  readonly startedAt: number | null;
  /** From `/health.projects.needsConsent`; null when the service is not reachable. */
  readonly pendingConsents: number | null;
  /** A service of another version is running; `start` replaces it with the shipped build. */
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

export type HomeRoute = "projects" | "connections" | "settings";

/** What the current Electron window is showing. */
export type WindowContext =
  | { readonly kind: "home"; readonly route: HomeRoute }
  | { readonly kind: "project"; readonly projectId: string };

export interface OpenProjectWindowOptions {
  /** Open a separate window; without it a home window is reused. */
  readonly newWindow?: boolean;
}

/** A project name for the File and tray menus. */
export interface ProjectMenuItem {
  readonly id: string;
  readonly name: string;
}

/** The object exposed as `window.ballast` in every Ballast window. */
export interface BallastBridge {
  readonly version: typeof BRIDGE_VERSION;
  readonly service: {
    status(): Promise<ServiceStatus>;
    /** Start the shipped service, or replace a running one of another version. */
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
  readonly windows: {
    /** What this window is currently showing. */
    context(): Promise<WindowContext>;
    /** Focus an existing project window, or reuse this home window / open one. */
    openProjectWindow(
      projectId: string,
      options?: OpenProjectWindowOptions,
    ): Promise<void>;
    /** Focus a home window at a service-wide route, opening it when needed. */
    openHome(route?: HomeRoute): Promise<void>;
  };
  readonly projects: {
    /** Feed the File and tray menus the current project list. */
    setMenu(projects: ReadonlyArray<ProjectMenuItem>): Promise<void>;
  };
  readonly app: {
    info(): Promise<AppInfo>;
    /** Ask main to navigate this window to the running service's UI. */
    openUi(): Promise<void>;
    /** Re-run discovery and navigate when the service is ready. */
    retry(): Promise<void>;
    showLogs(): Promise<void>;
    openExternal(url: string): Promise<void>;
    /** Native folder picker for project creation; null when cancelled. */
    pickDirectory(): Promise<string | null>;
  };
  readonly events: {
    onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
    onUpdateStatus(listener: (state: UpdateState) => void): () => void;
  };
}
