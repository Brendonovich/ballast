import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { ProjectFile, ProjectFileContent } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatDateTime, formatRelative } from "../../lib/format.ts";
import { languageForPath, tokenizeSource } from "../../lib/highlight.ts";
import type { SourceLanguage, SourceToken } from "../../lib/highlight.ts";
import {
  CopyIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
} from "../../ui/icons.tsx";
import { Button, IconButton, Spinner, cx } from "../../ui/primitives.tsx";

export interface SourceJump {
  readonly file: string;
  readonly line: number;
  readonly token: number;
}

const languageOf = (file: ProjectFileContent): SourceLanguage | undefined =>
  file.language === "text" ? undefined : (languageForPath(file.path) ?? file.language);

const fileDepth = (path: string): number => path.split("/").length - 1;

const fileName = (path: string): string => path.split("/").at(-1) ?? path;

export const SourcePanel = (props: {
  readonly projectId: string;
  readonly jump: SourceJump | undefined;
  readonly collapsed: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximize: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [files, setFiles] = createSignal<ReadonlyArray<ProjectFile>>([]);
  const [entry, setEntry] = createSignal("ballast.ts");
  const [source, setSource] = createSignal<ProjectFileContent>();
  const [selected, setSelected] = createSignal<string>();
  const [targetLine, setTargetLine] = createSignal<number>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let codeScroller: HTMLDivElement | undefined;
  let request = 0;
  let lastRevision = -1;
  let lastJump = -1;

  const rows = createMemo(() =>
    files().map((file) => ({
      ...file,
      depth: fileDepth(file.path),
      label: fileName(file.path),
    })),
  );

  const lines = createMemo(() => source()?.content.split("\n") ?? []);

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

  const openFile = async (path: string, line?: number): Promise<void> => {
    const current = ++request;
    setSelected(path);
    setLoading(true);
    const value = await store.readProjectFile(props.projectId, path);
    if (current !== request) return;
    setLoading(false);
    if (value === undefined) {
      setError(store.lastActionError() ?? "Could not read the file.");
      return;
    }
    setError(undefined);
    setSource(value);
    setTargetLine(line);
  };

  const loadTree = async (): Promise<string | undefined> => {
    const tree = await store.listProjectFiles(props.projectId);
    if (tree === undefined) {
      setError(store.lastActionError() ?? "Could not list the project files.");
      return undefined;
    }
    setFiles(tree.files);
    setEntry(tree.entry);
    return tree.entry;
  };

  const refresh = async (): Promise<void> => {
    const entryPath = await loadTree();
    const path = selected() ?? entryPath ?? entry();
    if (path !== undefined) await openFile(path, targetLine());
  };

  onMount(() => {
    void (async () => {
      const entryPath = await loadTree();
      const jump = props.jump;
      if (jump !== undefined) {
        lastJump = jump.token;
        await openFile(jump.file, jump.line);
        return;
      }
      if (entryPath !== undefined) await openFile(entryPath);
    })();
  });

  createEffect(() => {
    const revision = store.projectFileRevision(props.projectId);
    if (revision === lastRevision) return;
    lastRevision = revision;
    if (revision > 0) void refresh();
  });

  createEffect(() => {
    const jump = props.jump;
    if (jump === undefined || jump.token === lastJump) return;
    lastJump = jump.token;
    void openFile(jump.file, jump.line);
  });

  createEffect(() => {
    const value = source();
    const line = targetLine();
    if (value === undefined || line === undefined) return;
    queueMicrotask(() => scrollToLine(line));
  });

  const copyPath = async (): Promise<void> => {
    const value = source();
    if (value === undefined) return;
    try {
      await navigator.clipboard.writeText(value.path);
    } catch {
      // Clipboard access can be denied; the path stays selectable.
    }
  };

  return (
    <section
      class="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
      data-testid="source-panel"
    >
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5 text-[11px] text-faint">
        <span class="shrink-0 font-medium text-body">Source</span>
        <Show when={source()}>
          {(value) => (
            <>
              <span class="text-faint">·</span>
              <span class="min-w-0 truncate font-mono text-[11px] text-body">{value().path}</span>
              <span class="hidden shrink-0 lg:inline" title={formatDateTime(value().updatedAt)}>
                updated {formatRelative(value().updatedAt)}
              </span>
              <span class="ml-auto flex shrink-0 items-center gap-0.5">
                <IconButton label="Copy path" size="small" onClick={() => void copyPath()}>
                  <CopyIcon size={12} />
                </IconButton>
                <IconButton label="Refresh source" size="small" onClick={() => void refresh()}>
                  <RefreshIcon size={12} />
                </IconButton>
              </span>
            </>
          )}
        </Show>
        <span class={source() ? "" : "ml-auto"} />
        <IconButton
          label={props.maximized ? "Restore source pane" : "Maximize source pane"}
          size="small"
          testId="source-maximize"
          onClick={props.onToggleMaximize}
        >
          <Show when={props.maximized} fallback={<MaximizeIcon size={12} />}>
            <MinimizeIcon size={12} />
          </Show>
        </IconButton>
      </div>

      <Show when={!props.collapsed}>
        <div class="flex min-h-0 flex-1">
          <div
            data-testid="source-tree"
            class="hidden w-[156px] shrink-0 overflow-y-auto border-r border-edge py-1 md:block"
          >
            <For each={rows()}>
              {(row) => (
                <Show
                  when={row.kind === "file"}
                  fallback={
                    <p
                      class="truncate py-0.5 pr-2 font-mono text-[11px] text-faint"
                      style={{ "padding-left": `${8 + row.depth * 10}px` }}
                    >
                      {row.label}
                    </p>
                  }
                >
                  <button
                    type="button"
                    data-testid="source-file"
                    data-path={row.path}
                    class={cx(
                      "block w-full truncate py-0.5 pr-2 text-left font-mono text-[11px]",
                      selected() === row.path
                        ? "bg-layer-2 text-strong"
                        : "text-muted hover:bg-hover hover:text-body",
                    )}
                    style={{ "padding-left": `${8 + row.depth * 10}px` }}
                    onClick={() => void openFile(row.path)}
                  >
                    {row.label}
                  </button>
                </Show>
              )}
            </For>
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
                      <Button size="small" variant="outline" class="mt-3" onClick={() => void refresh()}>
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
            {(_file) => (
              <div ref={codeScroller} class="min-h-0 flex-1 overflow-auto bg-canvas">
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
                      return (
                        <div
                          data-line={lineNumber()}
                          data-highlighted={highlighted() ? "true" : undefined}
                          class={cx(
                            "flex",
                            highlighted() && "bg-[var(--v2-state-bg-warning)]",
                          )}
                        >
                          <span class="w-12 shrink-0 select-none pr-2 text-right text-faint">
                            {lineNumber()}
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
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
};
