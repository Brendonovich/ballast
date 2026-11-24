import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { ArtifactSummary, ArtifactView } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { artifactErrorSource, artifactStatusLabel } from "../../lib/format.ts";
import {
  MaximizeIcon,
  MinimizeIcon,
  MoreIcon,
} from "../../ui/icons.tsx";
import { Button, IconButton, Spinner } from "../../ui/primitives.tsx";
import { ArtifactUrlsDialog } from "./ArtifactUrlsDialog.tsx";

/**
 * The gateway is a different origin from the app, so keeping the artifact's
 * own origin does not expose app storage. Its CSP uses 'self', which an opaque
 * origin cannot match, so scripts would not run without allow-same-origin.
 */
const ARTIFACT_SANDBOX = "allow-scripts allow-same-origin";

export const ArtifactPanel = (props: {
  readonly projectId: string;
  readonly artifact: ArtifactSummary;
  readonly fullscreen: boolean;
  /** Pop-out windows: the window's top bar names the artifact, so no header. */
  readonly bare?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly onPopOut?: () => void;
  readonly onOpenSource?: (file: string, line: number) => void;
}): JSX.Element => {
  const store = useAgent();
  const [view, setView] = createSignal<ArtifactView>();
  const [error, setError] = createSignal<string>();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [urlsOpen, setUrlsOpen] = createSignal(false);
  let menu: HTMLDivElement | undefined;
  let refreshTimer: number | undefined;
  let renewAt = 0;
  let generation = 0;
  let loading = false;
  let renewing = false;
  let loadedKey = "";
  let loadedRequest = "";

  const clearRefresh = (): void => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const schedule = (expiresAt: number): void => {
    clearRefresh();
    const now = Date.now();
    const remaining = Math.max(0, expiresAt - now);
    // Renew at half the remaining TTL: well before expiry, and the same cadence
    // applies to every renewed expiry the service returns.
    const delay = Math.max(50, Math.floor(remaining / 2));
    renewAt = now + delay;
    refreshTimer = window.setTimeout(() => void renew(), delay);
  };

  const renew = async (): Promise<void> => {
    const current = view();
    if (current === undefined || loading || renewing) return;
    if (props.artifact.status !== "ready") return;
    clearRefresh();
    renewing = true;
    const started = generation;
    const next = await store.renewArtifactView(current.token);
    renewing = false;
    if (started !== generation) return;
    if (next === undefined) {
      // The service no longer recognizes the token (for example after a
      // restart). Mint a fresh view; this is the only renewal path that
      // reloads the iframe, and it keeps the old page visible until it does.
      void load();
      return;
    }
    schedule(next.expiresAt);
  };

  const load = async (): Promise<void> => {
    clearRefresh();
    if (props.artifact.status !== "ready") {
      generation += 1;
      loading = false;
      return;
    }
    const current = ++generation;
    loading = true;
    const next = await store.getArtifactView(props.projectId, props.artifact.name);
    if (current !== generation) return;
    loading = false;
    if (next === undefined) {
      if (view() === undefined) {
        setError(store.lastActionError() ?? "Could not open the artifact.");
      }
      renewAt = Date.now() + 10_000;
      refreshTimer = window.setTimeout(() => void load(), 10_000);
      return;
    }
    setError(undefined);
    setView(next);
    schedule(next.expiresAt);
  };

  createEffect(() => {
    const revision = store.artifactRevision(props.projectId, props.artifact.name);
    const status = props.artifact.status;
    const key = props.projectId + "\u0000" + props.artifact.name;
    const requestKey = key + "\u0000" + status + "\u0000" + String(revision);
    if (loadedKey !== key) {
      loadedKey = key;
      setView(undefined);
      setError(undefined);
      renewAt = 0;
    }
    if (loadedRequest === requestKey) return;
    loadedRequest = requestKey;
    if (status !== "ready") {
      clearRefresh();
      generation += 1;
      loading = false;
      renewing = false;
      setView(undefined);
      return;
    }
    void load();
  });

  onMount(() => {
    const closeMenu = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menu === undefined) return;
      if (!menu.contains(event.target)) setMenuOpen(false);
    };
    // Timers are throttled in hidden windows, so catch up when the window comes
    // back instead of waiting for an expired token's next renewal.
    const renewIfDue = (): void => {
      if (view() === undefined || document.visibilityState !== "visible") return;
      if (loading || renewing) return;
      if (Date.now() >= renewAt) void renew();
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("visibilitychange", renewIfDue);
    window.addEventListener("focus", renewIfDue);
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("visibilitychange", renewIfDue);
      window.removeEventListener("focus", renewIfDue);
    });
  });

  onCleanup(() => {
    clearRefresh();
    generation += 1;
    loading = false;
    renewing = false;
  });

  const errorSource = () => artifactErrorSource(props.artifact.error);

  return (
    <section
      data-testid="artifact-panel"
      class="flex h-full min-h-0 flex-col overflow-hidden bg-canvas"
    >
      <Show when={props.bare !== true}>
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-[11px]">
          <span class="min-w-0 truncate font-medium text-body">
            {props.artifact.title ?? props.artifact.name}
          </span>
          <span class="hidden shrink-0 text-[10px] text-faint sm:inline">
            {artifactStatusLabel(props.artifact.status)}
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-0.5">
            <Show when={props.onToggleFullscreen}>
              <IconButton
                label={props.fullscreen ? "Exit full screen" : "Full screen"}
                size="small"
                testId="artifact-fullscreen"
                onClick={() => props.onToggleFullscreen?.()}
              >
                <Show when={props.fullscreen} fallback={<MaximizeIcon size={12} />}>
                  <MinimizeIcon size={12} />
                </Show>
              </IconButton>
            </Show>
            <div ref={menu} class="relative">
              <IconButton
                label="Artifact actions"
                size="small"
                testId="artifact-menu"
                onClick={() => setMenuOpen((current) => !current)}
              >
                <MoreIcon size={13} />
              </IconButton>
              <Show when={menuOpen()}>
                <div class="absolute right-0 top-7 z-20 w-36 rounded-md border border-edge-strong bg-layer py-1 shadow-[var(--v2-elevation-overlay)]">
                  <button
                    type="button"
                    data-testid="artifact-urls"
                    class="block w-full px-2.5 py-1.5 text-left text-[12px] text-body hover:bg-hover"
                    onClick={() => {
                      setMenuOpen(false);
                      setUrlsOpen(true);
                    }}
                  >
                    URLs…
                  </button>
                  <Show when={props.onPopOut}>
                    <button
                      type="button"
                      data-testid="artifact-popout"
                      class="block w-full px-2.5 py-1.5 text-left text-[12px] text-body hover:bg-hover"
                      onClick={() => {
                        setMenuOpen(false);
                        props.onPopOut?.();
                      }}
                    >
                      Open in new window
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </span>
        </div>
      </Show>

      <div class="min-h-0 flex-1">
        <Show
          when={props.artifact.status === "ready"}
          fallback={
            <div class="grid h-full place-items-center px-6 text-center">
              <Show
                when={props.artifact.status === "error"}
                fallback={
                  <div class="flex items-center gap-2 text-[12px] text-muted">
                    <Spinner size={12} /> Building artifact…
                  </div>
                }
              >
                <div class="max-w-lg text-left">
                  <p class="text-[12px] font-medium text-danger">Artifact build failed</p>
                  <p class="mt-1 break-all text-[11px] text-body">
                    {props.artifact.error ?? "The artifact could not be built."}
                  </p>
                  <Show when={props.onOpenSource === undefined ? undefined : errorSource()}>
                    {(source) => (
                      <button
                        type="button"
                        data-testid="artifact-panel-error-source"
                        class="mt-2 font-mono text-[10px] text-danger hover:underline"
                        onClick={() => props.onOpenSource?.(source().file, source().line)}
                      >
                        {source().file}:{source().line}
                      </button>
                    )}
                  </Show>
                </div>
              </Show>
            </div>
          }
        >
          <Show
            when={view()}
            fallback={
              <div class="grid h-full place-items-center px-6 text-center">
                <Show
                  when={error() === undefined}
                  fallback={
                    <div>
                      <p class="text-[12px] text-danger">{error()}</p>
                      <Button
                        size="small"
                        variant="outline"
                        class="mt-3"
                        onClick={() => void load()}
                      >
                        Retry
                      </Button>
                    </div>
                  }
                >
                  <div class="flex items-center gap-2 text-[12px] text-muted">
                    <Spinner size={12} /> Opening artifact…
                  </div>
                </Show>
              </div>
            }
          >
            {(current) => (
              <iframe
                title={props.artifact.title ?? props.artifact.name}
                src={current().pageUrl}
                sandbox={ARTIFACT_SANDBOX}
                referrerpolicy="no-referrer"
                class="h-full w-full border-0 bg-[#0b1020]"
              />
            )}
          </Show>
        </Show>
      </div>

      <Show when={urlsOpen()}>
        <ArtifactUrlsDialog
          projectId={props.projectId}
          artifact={props.artifact}
          onClose={() => setUrlsOpen(false)}
        />
      </Show>
    </section>
  );
};
