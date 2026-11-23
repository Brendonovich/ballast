import { Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { ScriptSource } from "@ballast/agent-protocol";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";

import { useAgent } from "../../state/context.tsx";
import { formatDateTime, formatRelative } from "../../lib/format.ts";
import {
  CopyIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
} from "../../ui/icons.tsx";
import { Button, IconButton, Spinner } from "../../ui/primitives.tsx";

hljs.registerLanguage("typescript", typescript);

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const highlight = (content: string): string => {
  try {
    return hljs.highlight(content, { language: "typescript", ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(content);
  }
};

export const SourcePanel = (props: {
  readonly projectId: string;
  readonly scriptId: string;
  readonly collapsed: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximize: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [source, setSource] = createSignal<ScriptSource>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let request = 0;

  const load = async (): Promise<void> => {
    const current = ++request;
    setLoading(true);
    const value = await store.fetchScriptSource(props.projectId, props.scriptId);
    if (current !== request) return;
    setLoading(false);
    if (value === undefined) {
      setError(store.lastActionError() ?? "Could not read the source file.");
      return;
    }
    setError(undefined);
    setSource(value);
  };

  createEffect(() => {
    // HOOK(source-change): refetch when the service reports a source change.
    void store.scriptSourceRevision(props.projectId, props.scriptId);
    void load();
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

  const lineNumbers = (): string => {
    const value = source();
    if (value === undefined) return "";
    return Array.from({ length: value.content.split("\n").length }, (_, index) => index + 1).join(
      "\n",
    );
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
                <IconButton
                  label="Refresh source"
                  size="small"
                  onClick={() => void load()}
                >
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
                    <Button size="small" variant="outline" class="mt-3" onClick={() => void load()}>
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
          {(value) => (
            <div class="min-h-0 flex-1 overflow-auto bg-canvas">
              <pre class="m-0 flex min-w-max text-[12px] leading-5">
                <span class="sticky left-0 z-10 select-none border-r border-edge bg-canvas px-2 py-2 text-right font-mono text-faint">
                  {lineNumbers()}
                </span>
                <code
                  class="code-view block px-3 py-2 font-mono text-[12px] text-body"
                  innerHTML={highlight(value().content)}
                />
              </pre>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
};
