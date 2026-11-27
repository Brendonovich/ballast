import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { CodingAgent, ProjectAgentSetup } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { AGENTS, agentInfo, starterPrompt, startCommand } from "../../lib/onboarding.ts";
import { AgentLogo } from "../../ui/agent-logos.tsx";
import { CheckIcon, CopyIcon } from "../../ui/icons.tsx";
import { Button, Dialog, Spinner, cx } from "../../ui/primitives.tsx";

/** Copyable monospace text: a command, a prompt or a config snippet. */
export const CopyBlock = (props: {
  readonly text: string;
  readonly label?: string;
  readonly testId?: string;
  readonly wrap?: boolean;
}): JSX.Element => {
  const [copied, setCopied] = createSignal(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be denied; the text stays selectable.
    }
  };
  return (
    <div class="group relative min-w-0 rounded-md bg-canvas shadow-[var(--v2-elevation-input)]">
      <pre
        data-testid={props.testId}
        class={cx(
          "select-all py-2 pl-2.5 pr-16 font-mono text-[11px] leading-5 text-body",
          props.wrap === true ? "whitespace-pre-wrap break-words" : "overflow-x-auto",
        )}
      >
        {props.text}
      </pre>
      <button
        type="button"
        aria-label={props.label ?? "Copy"}
        class="absolute right-1.5 top-1.5 inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted hover:bg-hover hover:text-body"
        onClick={() => void copy()}
      >
        <Show when={copied()} fallback={<CopyIcon size={11} />}>
          <CheckIcon size={11} />
        </Show>
        {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  );
};

const configSnippet = (setup: ProjectAgentSetup): string =>
  JSON.stringify({ ballast: { command: setup.launcher.command, args: setup.launcher.args } }, null, 2);

/**
 * Configure coding agents for the Ballast MCP server for one project: pick
 * agents, write their project-local configs, then start the agent in the
 * folder with a starter prompt.
 */
export const AgentSetup = (props: {
  readonly projectId: string;
  readonly projectName: string;
}): JSX.Element => {
  const store = useAgent();
  const [setup, setSetup] = createSignal<ProjectAgentSetup>();
  const [selected, setSelected] = createSignal<ReadonlyArray<CodingAgent>>([]);
  const [showOther, setShowOther] = createSignal(false);

  const configured = (): ReadonlyArray<CodingAgent> =>
    setup()?.agents.filter((agent) => agent.configured).map((agent) => agent.agent) ?? [];
  const isConfigured = (agent: CodingAgent): boolean => configured().includes(agent);
  const isSelected = (agent: CodingAgent): boolean => selected().includes(agent);
  const pendingWrite = (): ReadonlyArray<CodingAgent> =>
    selected().filter((agent) => !isConfigured(agent));
  const fileOf = (agent: CodingAgent): string =>
    setup()?.agents.find((entry) => entry.agent === agent)?.file ?? "";

  onMount(() => {
    void store.getProjectAgentSetup(props.projectId).then((value) => {
      if (value === undefined) return;
      setSetup(value);
      const done = value.agents.filter((agent) => agent.configured).map((agent) => agent.agent);
      setSelected(done.length > 0 ? done : ["opencode"]);
    });
  });

  const writeLabel = (): string => {
    const pending = pendingWrite();
    const first = pending[0];
    if (first === undefined) return selected().length > 0 ? "Configured" : "Choose an agent";
    return pending.length === 1 ? `Configure ${agentInfo(first).name}` : `Configure ${pending.length} agents`;
  };

  const toggle = (agent: CodingAgent): void => {
    setSelected((current) =>
      current.includes(agent) ? current.filter((entry) => entry !== agent) : [...current, agent],
    );
  };

  const write = async (): Promise<void> => {
    const value = await store.writeProjectAgentConfigs(props.projectId, pendingWrite());
    if (value !== undefined) setSetup(value);
  };

  return (
    <Show
      when={setup()}
      fallback={
        <div class="flex items-center gap-2 py-6 text-[12px] text-muted">
          <Spinner size={12} /> Checking agent configs…
        </div>
      }
    >
      {(value) => (
        <div class="space-y-5" data-testid="agent-setup">
          <div>
            <p class="text-[12px] text-muted">
              Ballast adds a <code class="font-mono text-body">ballast</code> MCP server to each agent's
              config in the project folder, so the agent can read the guide, write the project and check
              it while Ballast runs it.
            </p>
            <div class="mt-3 grid grid-cols-3 gap-2">
              <For each={AGENTS}>
                {(agent) => (
                  <button
                    type="button"
                    data-testid={`agent-option-${agent.id}`}
                    aria-pressed={isSelected(agent.id)}
                    class={cx(
                      "flex flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors",
                      isSelected(agent.id)
                        ? "bg-[var(--v2-background-bg-layer-02)] shadow-[0_0_0_1px_var(--v2-border-border-focus)]"
                        : "bg-canvas shadow-[var(--v2-elevation-input)] hover:bg-hover",
                    )}
                    onClick={() => toggle(agent.id)}
                  >
                    <span class="flex w-full items-center gap-2 text-[13px] font-medium text-strong">
                      <AgentLogo agent={agent.id} size={16} class="shrink-0" />
                      {agent.name}
                      <Show when={isConfigured(agent.id)}>
                        <CheckIcon size={12} class="ml-auto text-success" />
                      </Show>
                    </span>
                    <span class="font-mono text-[10px] text-faint">{fileOf(agent.id)}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="mt-3 flex items-center gap-3">
              <Button
                variant="primary"
                data-testid="write-agent-configs"
                disabled={pendingWrite().length === 0}
                loading={store.isPending(`project:${props.projectId}:agents:write`)}
                onClick={() => void write()}
              >
                {writeLabel()}
              </Button>
              <button
                type="button"
                class="text-[12px] text-muted hover:text-body hover:underline"
                onClick={() => setShowOther((open) => !open)}
              >
                {showOther() ? "Hide" : "Using another agent?"}
              </button>
            </div>
            <Show when={showOther()}>
              <div class="mt-3 space-y-2" data-testid="agent-other">
                <p class="text-[12px] text-muted">
                  Add a local (stdio) MCP server named <code class="font-mono">ballast</code> that runs this
                  command with no arguments. It always starts the installed Ballast, so it keeps working
                  after updates.
                </p>
                <CopyBlock text={value().launcher.command} label="Copy command" />
                <CopyBlock text={configSnippet(value())} label="Copy JSON" />
              </div>
            </Show>
          </div>

          <Show when={configured().length > 0}>
            <div class="space-y-3 border-t border-edge pt-4" data-testid="agent-next-steps">
              <h3 class="text-[13px] font-medium text-strong">Start your agent in the project folder</h3>
              <For each={configured()}>
                {(agent) => (
                  <div class="space-y-1.5" data-testid={`agent-start-${agent}`}>
                    <p class="flex items-start gap-1.5 text-[12px] text-muted">
                      <AgentLogo agent={agent} size={13} class="mt-0.5 shrink-0" />
                      <span>
                      <span class="font-medium text-body">{agentInfo(agent).name}.</span>{" "}
                      {agentInfo(agent).firstRun}
                      </span>
                    </p>
                    <CopyBlock text={startCommand(value().root, agent)} label="Copy command" />
                  </div>
                )}
              </For>
              <div class="space-y-1.5">
                <p class="text-[12px] text-muted">Then tell it what to build. A first message:</p>
                <CopyBlock
                  text={starterPrompt(props.projectName)}
                  label="Copy prompt"
                  testId="agent-starter-prompt"
                  wrap
                />
              </div>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};

export const AgentSetupDialog = (props: {
  readonly projectId: string;
  readonly projectName: string;
  readonly onClose: () => void;
}): JSX.Element => (
  <Dialog
    title="Configure a coding agent"
    description={`Let your coding agent build ${props.projectName} through Ballast's MCP server.`}
    width="lg"
    onClose={props.onClose}
    footer={
      <Button variant="ghost" onClick={props.onClose}>
        Done
      </Button>
    }
  >
    <AgentSetup projectId={props.projectId} projectName={props.projectName} />
  </Dialog>
);
