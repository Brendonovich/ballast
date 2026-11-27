import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { ApplyProjectUpdateResult, ProjectSummary } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { AlertIcon, CopyIcon } from "../../ui/icons.tsx";
import { Button } from "../../ui/primitives.tsx";

const short = (sha: string): string => sha.slice(0, 8);

/**
 * Sharing state under the top bar (decision 0013): the share code for a
 * shared project, or the read-only note and "update available" banner for
 * a subscribed copy.
 */
export const ShareBar = (props: { readonly project: ProjectSummary }): JSX.Element => {
  const store = useAgent();
  const [copied, setCopied] = createSignal(false);
  const [applied, setApplied] = createSignal<ApplyProjectUpdateResult>();

  const copy = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be denied; the code stays visible to copy by hand.
    }
  };

  const apply = async (): Promise<void> => {
    setApplied(await store.applyProjectUpdate(props.project.id));
  };

  const share = () => props.project.share;
  const shared = () => {
    const value = share();
    return value?._tag === "shared" ? value : undefined;
  };
  const subscribed = () => {
    const value = share();
    return value?._tag === "subscribed" ? value : undefined;
  };

  return (
    <>
      <Show when={shared()}>
        {(value) => (
          <div
            data-testid="share-shared"
            class="flex shrink-0 items-center gap-2 rounded-[10px] bg-canvas px-3 py-1.5 text-[11px] text-muted shadow-[var(--v2-elevation-raised)]"
          >
            <span class="text-body">Shared</span>
            <span>·</span>
            <span>share code</span>
            <code data-testid="share-code" class="select-all font-mono text-[12px] text-strong">
              {value().shareCode}
            </code>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-accent hover:underline"
              onClick={() => void copy(value().shareCode)}
            >
              <CopyIcon size={11} /> {copied() ? "Copied" : "Copy"}
            </button>
            <Show when={value().sha}>
              {(sha) => <span class="ml-auto font-mono">deployed {short(sha())}</span>}
            </Show>
          </div>
        )}
      </Show>

      <Show when={subscribed()}>
        {(value) => (
          <Show
            when={value().available}
            fallback={
              <div
                data-testid="share-subscribed"
                class="flex shrink-0 items-center gap-2 rounded-[10px] bg-canvas px-3 py-1.5 text-[11px] text-muted shadow-[var(--v2-elevation-raised)]"
              >
                <span class="text-body">Read-only copy of a shared project</span>
                <span>·</span>
                <span class="font-mono">{short(value().installedSha)}</span>
                <Show when={applied()}>
                  {(result) => (
                    <span class="ml-auto">
                      Updated: {result().changed.length} changed, {result().deleted.length} deleted
                      {result().restarted ? ", restarted" : ""}
                    </span>
                  )}
                </Show>
              </div>
            }
          >
            {(update) => (
              <div
                data-testid="share-update-available"
                class="shrink-0 rounded-[10px] border border-[var(--v2-state-border-warning)] bg-[var(--v2-state-bg-warning)] px-3 py-2"
              >
                <div class="flex items-center gap-2.5">
                  <AlertIcon size={13} class="shrink-0 text-warning" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[12px] font-medium text-warning">
                      Update available · {short(update().sha)}
                      {update().message === null ? "" : " — " + update().message}
                    </p>
                    <p class="truncate text-[11px] text-body">
                      Applying replaces this read-only copy's files (local edits are overwritten) and
                      restarts the project once if it is running. New permissions still need approval.
                    </p>
                  </div>
                  <Button
                    size="small"
                    variant="primary"
                    data-testid="apply-project-update"
                    loading={store.isPending(`project:${props.project.id}:update`)}
                    onClick={() => void apply()}
                  >
                    Apply update
                  </Button>
                </div>
              </div>
            )}
          </Show>
        )}
      </Show>
    </>
  );
};
