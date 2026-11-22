import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { LogEntry, LogLevel } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatTime } from "../../lib/format.ts";
import { StatusDot } from "../../ui/primitives.tsx";
import { cx } from "../../ui/primitives.tsx";

const levelClass: Record<LogLevel, string> = {
  debug: "text-faint",
  info: "text-info",
  warn: "text-warning",
  error: "text-danger",
};

export const LogsPanel = (props: {
  readonly projectId: string;
  readonly scriptId: string;
}): JSX.Element => {
  const store = useAgent();
  const [clearedAt, setClearedAt] = createSignal(0);
  let scroller: HTMLDivElement | undefined;

  const scriptLogs = (): ReadonlyArray<LogEntry> =>
    store
      .logs()
      .filter(
        (entry) =>
          entry.projectId === props.projectId &&
          entry.scriptId === props.scriptId &&
          entry.seq > clearedAt(),
      );

  const clear = (): void => {
    const latest = store
      .logs()
      .filter((entry) => entry.projectId === props.projectId && entry.scriptId === props.scriptId)
      .at(-1)?.seq;
    setClearedAt(latest ?? 0);
  };

  createEffect(() => {
    const list = scriptLogs();
    if (list.length === 0) return;
    queueMicrotask(() => {
      if (scroller !== undefined) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  return (
    <div class="overflow-hidden rounded-md border border-edge" data-testid="log-panel">
      <div class="flex h-8 items-center gap-2 border-b border-edge px-2.5 text-[11px] text-faint">
        <StatusDot tone={store.logStatus() === "live" ? "success" : "warning"} />
        <span>{store.logStatus() === "live" ? "Live" : "Reconnecting"}</span>
        <span class="ml-auto tabular">{scriptLogs().length === 1 ? "1 line" : `${scriptLogs().length} lines`}</span>
        <button
          type="button"
          class="rounded px-1 text-muted hover:bg-hover hover:text-body"
          onClick={clear}
        >
          Clear
        </button>
      </div>
      <div
        ref={scroller}
        class="max-h-[calc(100vh-410px)] min-h-56 overflow-y-auto font-mono text-[11px] leading-5"
      >
        <Show
          when={scriptLogs().length > 0}
          fallback={
            <p class="px-3 py-10 text-center text-[12px] text-faint">
              No log lines for this script yet.
            </p>
          }
        >
          <For each={scriptLogs()}>
            {(entry) => (
              <div
                data-testid="log-line"
                class="flex items-start gap-3 border-b border-edge/60 px-2.5 py-1 last:border-b-0 hover:bg-hover"
              >
                <span class="tabular shrink-0 pt-px text-faint">{formatTime(entry.at)}</span>
                <span class={cx("w-9 shrink-0 pt-px text-[9px] uppercase", levelClass[entry.level])}>
                  {entry.level}
                </span>
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-body">
                  {entry.message}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};
