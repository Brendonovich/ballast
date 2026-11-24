import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { ProjectIssue, ProjectSummary } from "@ballast/agent-protocol";

import { formatDateTime, formatRelative } from "../lib/format.ts";
import {
  issueMessage,
  issueSummary,
  sortIssues,
  statusWord,
} from "../lib/project-health.ts";
import { AlertIcon, CheckIcon, ErrorIcon } from "../ui/icons.tsx";
import { cx } from "../ui/primitives.tsx";

/**
 * The top bar's status word. It opens an overlay listing the project's
 * issues, one line each; nothing in the page moves when it opens.
 */
export const ProjectStatusButton = (props: {
  readonly project: ProjectSummary;
  readonly onSelect: (issue: ProjectIssue) => void;
}): JSX.Element => {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  onMount(() => {
    const onPointer = (event: PointerEvent): void => {
      if (!open() || root === undefined) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && open()) {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  const issues = () => sortIssues(props.project.issues);

  return (
    <div ref={root} class="relative shrink-0">
      <button
        type="button"
        data-testid="project-status"
        data-status={props.project.status}
        data-issues={props.project.issues.length}
        aria-haspopup="dialog"
        aria-expanded={open()}
        title={issueSummary(props.project.issues)}
        class={cx(
          "inline-flex h-7 items-center rounded-md px-1.5 text-[12px] text-muted transition-colors hover:text-body",
          open() ? "bg-hover text-body" : "hover:bg-hover",
        )}
        onClick={() => setOpen((value) => !value)}
      >
        {statusWord(props.project.status)}
      </button>

      <Show when={open()}>
        <div
          role="dialog"
          aria-label="Project issues"
          data-testid="project-issues"
          data-no-drag
          class="absolute left-0 top-8 z-40 w-[360px] rounded-md border border-edge-strong bg-layer py-1 shadow-[var(--v2-elevation-overlay)]"
        >
          <Show
            when={issues().length > 0}
            fallback={
              <p
                data-testid="project-issues-empty"
                class="flex items-center gap-2 px-3 py-2.5 text-[12px] text-body"
              >
                <CheckIcon size={13} class="text-success" />
                Everything's working
              </p>
            }
          >
            <p class="px-3 pb-1 pt-1.5 text-[10px] text-faint">
              {issueSummary(issues())}
            </p>
            <div class="max-h-[60vh] overflow-y-auto px-1">
              <For each={issues()}>
                {(issue) => (
                  <button
                    type="button"
                    data-testid="project-issue"
                    data-issue-kind={issue.kind}
                    data-severity={issue.severity}
                    class="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-hover"
                    onClick={() => {
                      setOpen(false);
                      props.onSelect(issue);
                    }}
                  >
                    <Show
                      when={issue.severity === "error"}
                      fallback={<AlertIcon size={13} class="mt-px shrink-0 text-warning" />}
                    >
                      <ErrorIcon size={13} class="mt-px shrink-0 text-danger" />
                    </Show>
                    <span class="min-w-0 flex-1">
                      <span class="flex items-baseline gap-2">
                        <span class="min-w-0 flex-1 truncate text-[12px] text-body">
                          {issue.title}
                        </span>
                        <span
                          class="tabular shrink-0 text-[10px] text-faint"
                          title={formatDateTime(issue.at)}
                        >
                          {formatRelative(issue.at)}
                        </span>
                      </span>
                      <Show when={issue.detail !== undefined || issue.source !== undefined}>
                        <span class="mt-0.5 line-clamp-2 block break-words text-[11px] text-faint">
                          <Show when={issue.source}>
                            {(source) => (
                              <span class="mr-1.5 font-mono text-[10px]">
                                {source().file}:{source().line}
                              </span>
                            )}
                          </Show>
                          <Show when={issue.detail !== undefined}>{issueMessage(issue)}</Show>
                        </span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
