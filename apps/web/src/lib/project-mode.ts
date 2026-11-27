/**
 * The project window's mode: Develop edits the project (Files, Outline, tabs,
 * logs); View shows only its artifacts and parameters. Persisted per project
 * like the rest of the window's layout.
 */
export type ProjectMode = "view" | "develop";

export const DEFAULT_PROJECT_MODE: ProjectMode = "develop";

/** Keyed by project: each window shows one project, so this is per window. */
export const projectModeStorageKey = (projectId: string): string =>
  `ballast.projectMode.${projectId}`;

/** Only an explicit "view" opts out of the default Develop mode. */
export const parseProjectMode = (raw: string | null): ProjectMode =>
  raw === "view" ? "view" : DEFAULT_PROJECT_MODE;
