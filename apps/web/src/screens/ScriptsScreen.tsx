import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ScriptSummary } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { scriptKey } from "../state/store.ts";
import {
  formatRelative,
  isScriptBusy,
  plural,
  scriptDisplayName,
  scriptStatusLabel,
  scriptStatusTone,
} from "../lib/format.ts";
import { PlayIcon, StopIcon } from "../ui/icons.tsx";
import {
  Button,
  EmptyState,
  PageHeader,
  StatusDot,
  cx,
} from "../ui/primitives.tsx";

const scriptHref = (script: ScriptSummary): string =>
  `/scripts/${encodeURIComponent(script.projectId)}/${encodeURIComponent(script.id)}`;

export const ScriptsScreen = (): JSX.Element => {
  const store = useAgent();
  const navigate = useNavigate();

  const project = createMemo(() => store.currentProject());
  const scripts = createMemo(() => store.visibleScripts());
  const running = createMemo(() => scripts().filter((script) => script.status === "running").length);

  const toggle = async (script: ScriptSummary): Promise<void> => {
    if (script.status === "needs-consent") {
      navigate(scriptHref(script));
      return;
    }
    if (script.status === "running" || isScriptBusy(script.status)) {
      await store.stopScript(script.projectId, script.id);
    } else {
      await store.startScript(script.projectId, script.id);
    }
  };

  return (
    <div>
      <PageHeader
        title="Scripts"
        description={
          project() === undefined
            ? "Add a project in Settings to discover scripts."
            : project()?.root
        }
      />

      <Show
        when={project() !== undefined}
        fallback={
          <EmptyState
            title="No project selected"
            description="Projects live in Settings. Add a folder and its scripts appear here."
            action={
              <Button variant="neutral" onClick={() => navigate("/settings")}>
                Open Settings
              </Button>
            }
          />
        }
      >
        <Show
          when={scripts().length > 0}
          fallback={
            <EmptyState
              title="No scripts in this project"
              description="Add .ts files under scripts/ in the project folder. The agent plans them, and nothing starts automatically."
            />
          }
        >
          <div class="mt-6 border-t border-edge">
            <For each={scripts()}>
              {(script) => {
                const pending = (): string => scriptKey(script.projectId, script.id);
                return (
                  <div
                    data-testid="script-row"
                    data-script-id={script.id}
                    class="group flex min-h-12 items-center gap-3 border-b border-edge py-1.5"
                  >
                    <StatusDot
                      tone={scriptStatusTone(script)}
                      pulse={isScriptBusy(script.status)}
                      class="ml-1"
                    />
                    <button
                      type="button"
                      class="min-w-0 flex-1 rounded-sm py-1 text-left"
                      onClick={() => navigate(scriptHref(script))}
                    >
                      <span class="block truncate text-[13px] font-medium text-strong group-hover:text-accent">
                        {scriptDisplayName(script)}
                      </span>
                      <span class="block truncate font-mono text-[11px] text-faint">
                        {script.entry}
                      </span>
                    </button>
                    <span
                      class={cx(
                        "hidden w-28 whitespace-nowrap text-right text-[12px] sm:block",
                        script.status === "error" ? "text-danger" : "text-muted",
                      )}
                      title={`updated ${formatRelative(script.updatedAt)}`}
                    >
                      {scriptStatusLabel(script)}
                    </span>
                    <Button
                      size="small"
                      variant={
                        script.status === "running" || isScriptBusy(script.status)
                          ? "outline"
                          : "neutral"
                      }
                      loading={
                        store.isPending(`script:${pending()}:start`) ||
                        store.isPending(`script:${pending()}:stop`)
                      }
                      onClick={() => void toggle(script)}
                      icon={
                        script.status === "running" ? (
                          <StopIcon size={11} />
                        ) : script.status === "needs-consent" ? undefined : (
                          <PlayIcon size={11} />
                        )
                      }
                    >
                      {script.status === "needs-consent"
                        ? "Review"
                        : script.status === "running" || isScriptBusy(script.status)
                          ? "Stop"
                          : "Start"}
                    </Button>
                  </div>
                );
              }}
            </For>
          </div>
          <p class="mt-3 text-[11px] text-faint">
            {plural(scripts().length, "script")} · {running()} running
          </p>
        </Show>
      </Show>
    </div>
  );
};
