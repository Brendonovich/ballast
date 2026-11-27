import type { BrowserWindowConstructorOptions } from "electron";

/** Height of the web top bar; the macOS traffic lights are centred in it. */
export const TITLE_BAR_HEIGHT = 34;

/**
 * On macOS the web top bar is the title bar: the native one is hidden and the
 * traffic lights are inset into it. Other platforms keep their native frame.
 */
export const titleBarOptions = (
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition"> =>
  platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 13 } }
    : {};

/** Vite serves the UI; the real agent still serves data over its authenticated WebSocket. */
export const devWindowUrl = (
  base: string,
  connection: { readonly url: string; readonly token: string },
  hash: string,
): string => {
  const target = new URL(base);
  target.searchParams.set("service", connection.url);
  target.searchParams.set("token", connection.token);
  if (hash !== "") target.hash = hash;
  return target.toString();
};

export interface ScopedWindow {
  readonly id: number;
  readonly kind: "home" | "project" | "artifact";
  readonly projectId?: string;
}

export type RescopePlan =
  | { readonly action: "focus"; readonly id: number }
  | { readonly action: "rescope" }
  | { readonly action: "unchanged" }
  | { readonly action: "reject"; readonly reason: string };

/**
 * Windows stay one per project: switching a window to a project that another
 * window already shows focuses that window instead of duplicating it.
 */
export const planRescope = (
  windows: ReadonlyArray<ScopedWindow>,
  sourceId: number | undefined,
  projectId: string,
): RescopePlan => {
  const source = windows.find((entry) => entry.id === sourceId);
  if (source === undefined) return { action: "reject", reason: "unknown window" };
  if (source.kind === "artifact") {
    return { action: "reject", reason: "artifact windows cannot change project" };
  }
  if (source.kind === "project" && source.projectId === projectId) return { action: "unchanged" };
  const other = windows.find(
    (entry) => entry.id !== source.id && entry.kind === "project" && entry.projectId === projectId,
  );
  return other === undefined ? { action: "rescope" } : { action: "focus", id: other.id };
};
