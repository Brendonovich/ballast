import { createSignal } from "solid-js";

import type { IssueTarget } from "./project-health.ts";

/**
 * A request, made from the top bar, for the project view to show something:
 * an issue's target or the set-up flow. The project view may not be mounted
 * yet (the window can be on Connections), so the request waits here until it
 * is taken.
 */
export type ProjectIntent =
  | { readonly kind: "target"; readonly target: IssueTarget }
  | { readonly kind: "set-up" };

interface Pending {
  readonly projectId: string;
  readonly intent: ProjectIntent;
  readonly token: number;
}

const [pending, setPending] = createSignal<Pending>();
let token = 0;

export const requestProjectIntent = (projectId: string, intent: ProjectIntent): void => {
  token += 1;
  setPending({ projectId, intent, token });
};

export const pendingProjectIntent = pending;

/** Take the pending request for this project, once. */
export const takeProjectIntent = (projectId: string): ProjectIntent | undefined => {
  const current = pending();
  if (current === undefined || current.projectId !== projectId) return undefined;
  setPending(undefined);
  return current.intent;
};

const [connectionFocus, setConnectionFocus] = createSignal<string>();

/** Connections shows this instance's row first and flashes it. */
export const focusConnection = (connectionId: string): void => {
  setConnectionFocus(undefined);
  setConnectionFocus(connectionId);
};

export const pendingConnectionFocus = connectionFocus;

export const clearConnectionFocus = (): void => {
  setConnectionFocus(undefined);
};

/** Scroll an element into view and outline it briefly so the eye finds it. */
export const flash = (element: Element | null | undefined): void => {
  if (!(element instanceof HTMLElement)) return;
  element.scrollIntoView({ block: "nearest" });
  element.dataset.flash = "true";
  window.setTimeout(() => {
    delete element.dataset.flash;
  }, 1_400);
};
