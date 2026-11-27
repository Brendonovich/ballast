import { createSignal } from "solid-js";

import { parseProjectMode, projectModeStorageKey } from "../lib/project-mode.ts";
import type { ProjectMode } from "../lib/project-mode.ts";

const [modes, setModes] = createSignal<Readonly<Record<string, ProjectMode>>>({});

/**
 * The mode for a project window. The first read comes from localStorage and
 * later changes are held in this signal, so the top bar (which owns the
 * toggle) and the project screen see the same value.
 */
export const projectMode = (projectId: string): ProjectMode => {
  const cached = modes()[projectId];
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return "develop";
  try {
    return parseProjectMode(window.localStorage.getItem(projectModeStorageKey(projectId)));
  } catch {
    return "develop";
  }
};

export const setProjectMode = (projectId: string, next: ProjectMode): void => {
  setModes((current) => ({ ...current, [projectId]: next }));
  try {
    window.localStorage.setItem(projectModeStorageKey(projectId), next);
  } catch {
    // Non-critical.
  }
};
