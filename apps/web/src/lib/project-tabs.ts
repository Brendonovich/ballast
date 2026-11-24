/**
 * The project window's tabs: files, artifacts and topic event views, one
 * shown at a time. Open tabs and the active one persist per project window.
 */
export type ProjectTab =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "artifact"; readonly name: string }
  | { readonly kind: "topic"; readonly name: string };

export interface TabsState {
  readonly tabs: ReadonlyArray<ProjectTab>;
  readonly active: string | undefined;
}

export const tabKey = (tab: ProjectTab): string =>
  tab.kind === "file" ? `file:${tab.path}` : `${tab.kind}:${tab.name}`;

export const EMPTY_TABS: TabsState = { tabs: [], active: undefined };

/** Nothing opened yet: the entry file. */
export const defaultTabs = (entry: string): TabsState => {
  const tab: ProjectTab = { kind: "file", path: entry };
  return { tabs: [tab], active: tabKey(tab) };
};

export const activeTab = (state: TabsState): ProjectTab | undefined =>
  state.tabs.find((tab) => tabKey(tab) === state.active);

/** Opening something already open focuses it; anything else is appended. */
export const openTab = (state: TabsState, tab: ProjectTab): TabsState => {
  const key = tabKey(tab);
  if (state.tabs.some((entry) => tabKey(entry) === key)) return { ...state, active: key };
  return { tabs: [...state.tabs, tab], active: key };
};

export const activateTab = (state: TabsState, key: string): TabsState =>
  state.tabs.some((tab) => tabKey(tab) === key) ? { ...state, active: key } : state;

/** Closing the active tab focuses its right neighbour, else its left. */
export const closeTab = (state: TabsState, key: string): TabsState => {
  const index = state.tabs.findIndex((tab) => tabKey(tab) === key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((_, position) => position !== index);
  if (state.active !== key) return { tabs, active: state.active };
  const next = tabs[index] ?? tabs[index - 1];
  return { tabs, active: next === undefined ? undefined : tabKey(next) };
};

const parseTab = (value: unknown): ProjectTab | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "file") {
    const path: unknown = Reflect.get(value, "path");
    return typeof path === "string" && path !== "" ? { kind, path } : undefined;
  }
  if (kind === "artifact" || kind === "topic") {
    const name: unknown = Reflect.get(value, "name");
    return typeof name === "string" && name !== "" ? { kind, name } : undefined;
  }
  return undefined;
};

/**
 * A stored state, or `undefined` when nothing was stored (or it is
 * unreadable) so the caller can open the entry file instead. Duplicate and
 * malformed tabs are dropped; a missing active tab falls back to the first.
 */
export const parseTabs = (raw: string | null): TabsState | undefined => {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const list: unknown = Reflect.get(value, "tabs");
    if (!Array.isArray(list)) return undefined;
    const tabs: Array<ProjectTab> = [];
    for (const entry of list) {
      const tab = parseTab(entry);
      if (tab !== undefined && !tabs.some((existing) => tabKey(existing) === tabKey(tab))) {
        tabs.push(tab);
      }
    }
    const active: unknown = Reflect.get(value, "active");
    const first = tabs[0];
    return {
      tabs,
      active:
        typeof active === "string" && tabs.some((tab) => tabKey(tab) === active)
          ? active
          : first === undefined
            ? undefined
            : tabKey(first),
    };
  } catch {
    return undefined;
  }
};

/** Keyed by project: each window shows one project, so this is per window. */
export const tabsStorageKey = (projectId: string): string => `ballast.projectTabs.${projectId}`;
