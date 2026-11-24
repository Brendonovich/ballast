import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import type { ProjectFileContent } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatDateTime, formatRelative } from "../../lib/format.ts";
import { languageForPath, tokenizeSource } from "../../lib/highlight.ts";
import type { SourceLanguage, SourceToken } from "../../lib/highlight.ts";
import type { SourceMarker } from "../../lib/project-health.ts";
import { CopyIcon, RefreshIcon } from "../../ui/icons.tsx";
import { Button, IconButton, Spinner, cx } from "../../ui/primitives.tsx";

/** A request to show a line, highlighted. A new token re-scrolls to it. */
export interface SourceJump {
  readonly file: string;
  readonly line: number;
  readonly token: number;
}

const languageOf = (file: ProjectFileContent): SourceLanguage | undefined =>
  file.language === "text" ? undefined : (languageForPath(file.path) ?? file.language);

/** One project file in a tab, with the change-not-applied gutter markers. */
export const FileView = (props: {
  readonly projectId: string;
  readonly path: string;
  /** Set when this file was opened at a line (a code icon, an issue). */
  readonly jump: SourceJump | undefined;
  readonly markers?: ReadonlyArray<SourceMarker>;
  /** Reload the tree too, so new files show in Files. */
  readonly onRefreshTree?: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [source, setSource] = createSignal<ProjectFileContent>();
  const [targetLine, setTargetLine] = createSignal<number>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let codeScroller: HTMLDivElement | undefined;
  let request = 0;
  let lastJump = -1;

  const lines = createMemo(() => source()?.content.split("\n") ?? []);

  /** Markers for this file, by line. */
  const markerLines = createMemo(() => {
    const map = new Map<number, SourceMarker>();
    for (const marker of props.markers ?? []) {
      if (marker.file === props.path && !map.has(marker.line)) map.set(marker.line, marker);
    }
    return map;
  });

  // The file paints as plain text at once; tokens replace it when Shiki is
  // ready. The whole file is tokenized together so multi-line strings and
  // comments keep their colors.
  const [tokens, setTokens] = createSignal<ReadonlyArray<ReadonlyArray<SourceToken>>>();
  const [highlightMs, setHighlightMs] = createSignal<number>();
  let highlightRequest = 0;
  createEffect(() => {
    const file = source();
    const current = ++highlightRequest;
    setTokens(undefined);
    setHighlightMs(undefined);
    if (file === undefined) return;
    const language = languageOf(file);
    if (language === undefined) return;
    const started = performance.now();
    void tokenizeSource(file.content, language)
      .then((result) => {
        if (current !== highlightRequest) return;
        setTokens(result);
        requestAnimationFrame(() => {
          if (current === highlightRequest) setHighlightMs(Math.round(performance.now() - started));
        });
      })
      .catch(() => {
        // Plain text stays; highlighting is cosmetic.
      });
  });

  const scrollToLine = (line: number): void => {
    const scroller = codeScroller;
    if (scroller === undefined) return;
    const element = scroller.querySelector(`[data-line="${line}"]`);
    if (!(element instanceof HTMLElement)) return;
    const top =
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
  };

  const load = async (): Promise<void> => {
    const current = ++request;
    setLoading(true);
    const value = await store.readProjectFile(props.projectId, props.path);
    if (current !== request) return;
    setLoading(false);
    if (value === undefined) {
      setError(store.lastActionError() ?? "Could not read the file.");
      setSource(undefined);
      return;
    }
    setError(undefined);
    setSource(value);
  };

  // Reload when the project's files change on disk.
  createEffect(
    on(
      () => [props.path, store.projectFileRevision(props.projectId)] as const,
      () => void load(),
    ),
  );

  createEffect(() => {
    const jump = props.jump;
    if (jump === undefined || jump.token === lastJump) return;
    lastJump = jump.token;
    setTargetLine(jump.line);
    if (source() !== undefined) queueMicrotask(() => scrollToLine(jump.line));
  });

  createEffect(
    on(source, (value) => {
      const line = targetLine();
      if (value === undefined || line === undefined) return;
      queueMicrotask(() => scrollToLine(line));
    }),
  );

  const refresh = (): void => {
    props.onRefreshTree?.();
    void load();
  };

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.path);
    } catch {
      // Clipboard access can be denied; the path stays selectable.
    }
  };

  return (
    <section
      class="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="source-panel"
      data-path={props.path}
    >
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-[11px] text-faint">
        <span class="min-w-0 truncate font-mono text-[11px] text-body">{props.path}</span>
        <Show when={source()}>
          {(value) => (
            <span class="hidden shrink-0 lg:inline" title={formatDateTime(value().updatedAt)}>
              updated {formatRelative(value().updatedAt)}
            </span>
          )}
        </Show>
        <span class="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label="Copy path" size="small" onClick={() => void copyPath()}>
            <CopyIcon size={12} />
          </IconButton>
          <IconButton label="Refresh source" size="small" onClick={refresh}>
            <RefreshIcon size={12} />
          </IconButton>
        </span>
      </div>

      <Show
        when={source()}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-muted">
            <Show
              when={loading()}
              fallback={
                <div class="px-4 text-center">
                  <p class="text-danger">Could not load source</p>
                  <p class="mt-1 text-faint">{error()}</p>
                  <Button size="small" variant="outline" class="mt-3" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              }
            >
              <Spinner size={12} /> Loading source…
            </Show>
          </div>
        }
      >
        <div ref={codeScroller} class="min-h-0 flex-1 overflow-auto">
          <div
            data-testid="code-view"
            data-highlight={tokens() === undefined ? "plain" : "tokens"}
            data-highlight-ms={highlightMs()}
            class="code-view min-w-max py-2 font-mono text-[12px] leading-5"
          >
            <For each={lines()}>
              {(line, index) => {
                const lineNumber = (): number => index() + 1;
                const highlighted = (): boolean => targetLine() === lineNumber();
                const marker = (): SourceMarker | undefined => markerLines().get(lineNumber());
                return (
                  <div
                    data-line={lineNumber()}
                    data-highlighted={highlighted() ? "true" : undefined}
                    data-marked={marker() === undefined ? undefined : "true"}
                    class={cx(
                      "flex",
                      highlighted()
                        ? "bg-[var(--v2-state-bg-warning)]"
                        : marker() !== undefined && "bg-[var(--v2-state-bg-danger)]",
                    )}
                  >
                    <span class="relative flex w-12 shrink-0 select-none items-center justify-end gap-1 pr-2 text-faint">
                      <Show when={marker()}>
                        {(current) => (
                          <span
                            data-testid="source-marker"
                            tabIndex={0}
                            role="img"
                            aria-label={`${current().title}: ${current().message}`}
                            class="group/marker absolute left-1 flex h-5 items-center outline-none"
                          >
                            <span class="size-2 rounded-full bg-danger" />
                            <span
                              role="tooltip"
                              data-testid="source-marker-tooltip"
                              class="pointer-events-none invisible absolute left-3 top-5 z-30 w-max max-w-[420px] whitespace-normal rounded-md border border-edge-strong bg-layer px-2.5 py-1.5 text-left font-sans text-[11px] leading-4 text-body opacity-0 shadow-[var(--v2-elevation-overlay)] transition-opacity group-hover/marker:visible group-hover/marker:opacity-100 group-focus/marker:visible group-focus/marker:opacity-100"
                            >
                              <span class="block font-medium text-danger">{current().title}</span>
                              <span class="mt-0.5 block break-words">{current().message}</span>
                            </span>
                          </span>
                        )}
                      </Show>
                      <span class={marker() === undefined ? undefined : "text-danger"}>
                        {lineNumber()}
                      </span>
                    </span>
                    <code class="block whitespace-pre px-3 text-[var(--syntax-variable)]">
                      <Show when={tokens()?.[index()]} fallback={line === "" ? " " : line}>
                        {(lineTokens) => (
                          <Show when={lineTokens().length > 0} fallback=" ">
                            <For each={lineTokens()}>
                              {(token) => (
                                <span
                                  style={token.color === undefined ? undefined : { color: token.color }}
                                  class={token.italic ? "italic" : undefined}
                                >
                                  {token.content}
                                </span>
                              )}
                            </For>
                          </Show>
                        )}
                      </Show>
                    </code>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </section>
  );
};
