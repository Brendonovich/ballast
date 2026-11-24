import { createSignal } from "solid-js";

import { SIDEBAR_HIDDEN_KEY } from "../lib/sidebar-layout.ts";

const read = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
};

const [hidden, setHidden] = createSignal(read());

/**
 * Whether the project window's left sidebar (Files and Outline) is hidden.
 * The top bar toggles it and the project screen reads it, so it lives here.
 */
export const leftSidebarHidden = hidden;

export const setLeftSidebarHidden = (next: boolean): void => {
  setHidden(next);
  try {
    window.localStorage.setItem(SIDEBAR_HIDDEN_KEY, String(next));
  } catch {
    // Non-critical.
  }
};

export const toggleLeftSidebar = (): void => setLeftSidebarHidden(!hidden());
