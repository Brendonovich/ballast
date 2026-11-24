/**
 * The project window's left sidebar: Files above the Outline, each
 * collapsible to its header, with a persisted split between them. The whole
 * sidebar can be hidden from the top bar (⌘B / Ctrl+B).
 */
export interface SidebarLayout {
  readonly filesOpen: boolean;
  readonly outlineOpen: boolean;
  /** Share of the height given to Files while both are open. */
  readonly split: number;
}

export const SIDEBAR_SPLIT_MIN = 0.15;
export const SIDEBAR_SPLIT_MAX = 0.85;
export const DEFAULT_SIDEBAR: SidebarLayout = { filesOpen: true, outlineOpen: true, split: 0.4 };

export const clampSidebarSplit = (ratio: number): number =>
  Math.min(SIDEBAR_SPLIT_MAX, Math.max(SIDEBAR_SPLIT_MIN, ratio));

/** Both open by default; a malformed value falls back to the default. */
export const parseSidebarLayout = (raw: string | null): SidebarLayout => {
  if (raw === null) return DEFAULT_SIDEBAR;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_SIDEBAR;
    const filesOpen: unknown = Reflect.get(value, "filesOpen");
    const outlineOpen: unknown = Reflect.get(value, "outlineOpen");
    const split: unknown = Reflect.get(value, "split");
    return {
      filesOpen: typeof filesOpen === "boolean" ? filesOpen : DEFAULT_SIDEBAR.filesOpen,
      outlineOpen: typeof outlineOpen === "boolean" ? outlineOpen : DEFAULT_SIDEBAR.outlineOpen,
      split:
        typeof split === "number" && Number.isFinite(split)
          ? clampSidebarSplit(split)
          : DEFAULT_SIDEBAR.split,
    };
  } catch {
    return DEFAULT_SIDEBAR;
  }
};

/** Keyed by project: each window shows one project, so this is per window. */
export const sidebarStorageKey = (projectId: string): string =>
  `ballast.projectSidebar.${projectId}`;

/** Whether the left sidebar is hidden; one setting for every project window. */
export const SIDEBAR_HIDDEN_KEY = "ballast.leftSidebarHidden";

/** ⌘B on macOS, Ctrl+B elsewhere. */
export const isSidebarShortcut = (
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): boolean =>
  event.key.toLowerCase() === "b" &&
  !event.altKey &&
  !event.shiftKey &&
  (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
