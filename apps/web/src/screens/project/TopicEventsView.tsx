import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { EventHistoryEntry, EventHistorySubscription } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatDateTime, formatRelative, formatTime } from "../../lib/format.ts";
import { tokenizeSource } from "../../lib/highlight.ts";
import type { SourceToken } from "../../lib/highlight.ts";
import { CopyIcon } from "../../ui/icons.tsx";
import { Button, IconButton, Spinner, cx } from "../../ui/primitives.tsx";

/** Rows per page, for the first load, polling and "Load older". */
export const EVENT_PAGE_SIZE = 50;
/** How often a visible topic tab checks for new events. */
export const EVENT_POLL_MS = 2_000;

const preview = (event: unknown): string => {
  try {
    const text = JSON.stringify(event) ?? String(event);
    return text.length > 240 ? text.slice(0, 240) + "…" : text;
  } catch {
    return String(event);
  }
};

const pretty = (event: unknown): string => {
  try {
    return JSON.stringify(event, null, 2) ?? String(event);
  } catch {
    return String(event);
  }
};

type Availability =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  /** The subscription declares history: false. */
  | { readonly kind: "off" }
  /** Not registered with the service, e.g. the project is not running. */
  | { readonly kind: "unlisted" }
  | { readonly kind: "on"; readonly subscription: EventHistorySubscription };

/**
 * The durable event history of one topic subscription, newest first. A
 * visible tab polls for new rows: the service has no history stream.
 */
export const TopicEventsView = (props: {
  readonly projectId: string;
  readonly name: string;
  readonly title?: string;
}): JSX.Element => {
  const store = useAgent();
  const [availability, setAvailability] = createSignal<Availability>({ kind: "loading" });
  const [entries, setEntries] = createSignal<ReadonlyArray<EventHistoryEntry>>([]);
  const [olderCursor, setOlderCursor] = createSignal<string>();
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [selectedCursor, setSelectedCursor] = createSignal<string>();
  let generation = 0;
  let polling = false;

  const selected = createMemo(() => {
    const cursor = selectedCursor();
    return cursor === undefined ? undefined : entries().find((entry) => entry.cursor === cursor);
  });

  /** Prepend rows not seen yet; the page is newest first. */
  const merge = (page: ReadonlyArray<EventHistoryEntry>): void => {
    const known = new Set(entries().map((entry) => entry.cursor));
    const fresh = page.filter((entry) => !known.has(entry.cursor));
    if (fresh.length > 0) setEntries([...fresh, ...entries()]);
  };

  /** Check whether history is on, then load or merge the newest page. */
  const sync = async (initial: boolean): Promise<void> => {
    const current = generation;
    const listed = await store.listEventHistorySubscriptions(props.projectId, props.name);
    if (current !== generation) return;
    if (!listed.ok) {
      if (initial || entries().length === 0) setAvailability({ kind: "error", message: listed.message });
      return;
    }
    const subscription = listed.value.find((entry) => entry.name === props.name);
    if (subscription === undefined) {
      setAvailability({ kind: "unlisted" });
      return;
    }
    if (!subscription.history) {
      setAvailability({ kind: "off" });
      return;
    }
    const page = await store.queryEventHistory({
      projectId: props.projectId,
      subscription: props.name,
      limit: EVENT_PAGE_SIZE,
    });
    if (current !== generation) return;
    if (!page.ok) {
      if (initial || entries().length === 0) setAvailability({ kind: "error", message: page.message });
      return;
    }
    const wasOn = availability().kind === "on";
    setAvailability({ kind: "on", subscription });
    if (initial || !wasOn) {
      setEntries(page.value.entries);
      setOlderCursor(page.value.nextCursor);
      return;
    }
    merge(page.value.entries);
  };

  const reload = (): void => {
    generation += 1;
    setAvailability({ kind: "loading" });
    setEntries([]);
    setOlderCursor(undefined);
    setSelectedCursor(undefined);
    void sync(true);
  };

  createEffect(on(() => [props.projectId, props.name] as const, reload));

  onMount(() => {
    const handle = window.setInterval(() => {
      if (polling || document.visibilityState !== "visible") return;
      if (availability().kind === "loading") return;
      polling = true;
      void sync(false).finally(() => {
        polling = false;
      });
    }, EVENT_POLL_MS);
    onCleanup(() => window.clearInterval(handle));
  });

  const loadOlder = async (): Promise<void> => {
    const before = olderCursor();
    if (before === undefined || loadingOlder()) return;
    const current = generation;
    setLoadingOlder(true);
    const page = await store.queryEventHistory({
      projectId: props.projectId,
      subscription: props.name,
      limit: EVENT_PAGE_SIZE,
      before,
    });
    setLoadingOlder(false);
    if (current !== generation || !page.ok) return;
    const known = new Set(entries().map((entry) => entry.cursor));
    setEntries([...entries(), ...page.value.entries.filter((entry) => !known.has(entry.cursor))]);
    setOlderCursor(page.value.nextCursor);
  };

  const moveSelection = (offset: number): void => {
    const list = entries();
    const index = list.findIndex((entry) => entry.cursor === selectedCursor());
    const next = list[Math.max(0, Math.min(list.length - 1, index + offset))];
    if (next === undefined) return;
    setSelectedCursor(next.cursor);
    document
      .querySelector(`[data-testid="topic-event"][data-cursor="${CSS.escape(next.cursor)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const subscription = (): EventHistorySubscription | undefined => {
    const current = availability();
    return current.kind === "on" ? current.subscription : undefined;
  };

  return (
    <section
      data-testid="topic-events"
      data-topic={props.name}
      data-state={availability().kind}
      class="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-[11px] text-faint">
        <span class="shrink-0 font-medium text-body">{props.title ?? props.name}</span>
        <Show when={subscription()}>
          {(current) => (
            <>
              <span class="min-w-0 truncate font-mono">
                {current().integration} · {current().slot} · {current().topic}
              </span>
              <span
                data-testid="topic-events-count"
                class="tabular ml-auto shrink-0"
                title="Loaded here; older events load on demand"
              >
                {entries().length}
                {olderCursor() === undefined ? "" : "+"} {entries().length === 1 && olderCursor() === undefined ? "event" : "events"}
              </span>
            </>
          )}
        </Show>
      </div>

      <Switch>
        <Match when={availability().kind === "loading"}>
          <div class="flex flex-1 items-center justify-center gap-2 text-[12px] text-muted">
            <Spinner size={12} /> Loading events…
          </div>
        </Match>
        <Match when={availability().kind === "off"}>
          <Empty
            testId="topic-events-off"
            title="History is off for this topic"
            description="Its events still reach the script, but they aren't recorded."
          />
        </Match>
        <Match when={availability().kind === "unlisted"}>
          <Empty
            testId="topic-events-unlisted"
            title="No history yet"
            description="Events are recorded while the project is running."
          />
        </Match>
        <Match when={availability().kind === "error"}>
          <div class="flex flex-1 items-center justify-center px-6 text-center text-[12px]">
            <div>
              <p class="text-danger">Could not load events</p>
              <p class="mt-1 text-faint">
                {(() => {
                  const current = availability();
                  return current.kind === "error" ? current.message : "";
                })()}
              </p>
              <Button size="small" variant="outline" class="mt-3" onClick={reload}>
                Retry
              </Button>
            </div>
          </div>
        </Match>
        <Match when={availability().kind === "on" && entries().length === 0}>
          <Empty
            testId="topic-events-empty"
            title="No events recorded yet"
            description="New events show up here as they arrive."
          />
        </Match>
        <Match when={availability().kind === "on"}>
          <div class="flex min-h-0 flex-1">
            <div
              data-testid="topic-event-list"
              role="listbox"
              aria-label={`Events for ${props.name}`}
              tabIndex={0}
              class="min-h-0 w-[44%] min-w-[240px] max-w-[460px] shrink-0 overflow-y-auto border-r border-edge py-1 outline-none"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSelection(event.key === "ArrowDown" ? 1 : -1);
                }
              }}
            >
              <For each={entries()}>
                {(entry) => {
                  const active = (): boolean => selectedCursor() === entry.cursor;
                  return (
                    <div
                      role="option"
                      aria-selected={active()}
                      data-testid="topic-event"
                      data-cursor={entry.cursor}
                      data-selected={active() ? "true" : undefined}
                      title={`${formatDateTime(entry.receivedAt)} · ${formatRelative(entry.receivedAt)}`}
                      class={cx(
                        "mx-1 flex h-6 items-center gap-2.5 rounded px-2 text-[11px]",
                        active() ? "bg-layer-2" : "hover:bg-hover",
                      )}
                      onClick={() => setSelectedCursor(entry.cursor)}
                    >
                      <span class="tabular shrink-0 text-faint">{formatTime(entry.receivedAt)}</span>
                      <span class={cx("min-w-0 flex-1 truncate font-mono", active() ? "text-strong" : "text-body")}>
                        {preview(entry.event)}
                      </span>
                    </div>
                  );
                }}
              </For>
              <Show when={olderCursor() !== undefined}>
                <div class="px-2 py-2">
                  <Button
                    size="small"
                    variant="ghost"
                    class="w-full"
                    data-testid="topic-events-older"
                    loading={loadingOlder()}
                    onClick={() => void loadOlder()}
                  >
                    Load older
                  </Button>
                </div>
              </Show>
            </div>
            <div class="flex min-h-0 min-w-0 flex-1 flex-col">
              <Show
                when={selected()}
                fallback={
                  <div class="flex flex-1 items-center justify-center text-[12px] text-faint">
                    Select an event to see its payload.
                  </div>
                }
              >
                {(entry) => <EventDetail entry={entry()} />}
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </section>
  );
};

const Empty = (props: {
  readonly testId: string;
  readonly title: string;
  readonly description: string;
}): JSX.Element => (
  <div data-testid={props.testId} class="flex flex-1 items-center justify-center px-6 text-center">
    <div>
      <p class="text-[12px] font-medium text-body">{props.title}</p>
      <p class="mt-1 text-[11px] text-faint">{props.description}</p>
    </div>
  </div>
);

const EventDetail = (props: { readonly entry: EventHistoryEntry }): JSX.Element => {
  const text = createMemo(() => pretty(props.entry.event));
  const [tokens, setTokens] = createSignal<ReadonlyArray<ReadonlyArray<SourceToken>>>();
  let request = 0;
  createEffect(() => {
    const value = text();
    const current = ++request;
    setTokens(undefined);
    void tokenizeSource(value, "json")
      .then((result) => {
        if (current === request) setTokens(result);
      })
      .catch(() => {
        // Plain text stays; highlighting is cosmetic.
      });
  });
  const lines = createMemo(() => text().split("\n"));
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text());
    } catch {
      // Clipboard access can be denied; the payload stays selectable.
    }
  };
  return (
    <div data-testid="topic-event-detail" data-cursor={props.entry.cursor} class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-[11px] text-faint">
        <span class="text-body">{formatDateTime(props.entry.receivedAt)}</span>
        <span>{formatRelative(props.entry.receivedAt)}</span>
        <span class="ml-auto min-w-0 truncate font-mono" title="Cursor">
          {props.entry.cursor}
        </span>
        <IconButton label="Copy JSON" size="small" onClick={() => void copy()}>
          <CopyIcon size={12} />
        </IconButton>
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
        <pre
          data-testid="topic-event-json"
          data-highlight={tokens() === undefined ? "plain" : "tokens"}
          class="m-0 min-w-max px-3 py-2 font-mono text-[12px] leading-5 text-[var(--syntax-variable)]"
        >
          <For each={lines()}>
            {(line, index) => (
              <div>
                <Show when={tokens()?.[index()]} fallback={line === "" ? " " : line}>
                  {(lineTokens) => (
                    <For each={lineTokens()}>
                      {(token) => (
                        <span style={token.color === undefined ? undefined : { color: token.color }}>
                          {token.content}
                        </span>
                      )}
                    </For>
                  )}
                </Show>
              </div>
            )}
          </For>
        </pre>
      </div>
    </div>
  );
};
