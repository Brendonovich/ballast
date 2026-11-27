import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { CodingAgent, ProjectOpener, ProjectOpenerInfo, ProjectOpeners } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { agentInfo } from "../../lib/onboarding.ts";
import { AgentLogo } from "../../ui/agent-logos.tsx";
import { ChevronDownIcon, CodeIcon, FolderIcon, SettingsIcon, TerminalIcon } from "../../ui/icons.tsx";
import { Button, cx } from "../../ui/primitives.tsx";
import { AgentSetupDialog } from "./AgentSetup.tsx";

const CHOICE_KEY = "ballast.openIn";

/** One way to open the project: an app, or a coding agent's CLI in a terminal. */
interface OpenChoice {
  readonly opener: ProjectOpenerInfo;
  readonly agent?: CodingAgent;
}

const choiceKey = (choice: { readonly opener: ProjectOpener; readonly agent?: CodingAgent | undefined }): string =>
  choice.agent === undefined ? choice.opener : `${choice.opener}:${choice.agent}`;

const readChoice = (): string | undefined => {
  try {
    return window.localStorage.getItem(CHOICE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const writeChoice = (key: string): void => {
  try {
    window.localStorage.setItem(CHOICE_KEY, key);
  } catch {
    // Non-critical.
  }
};

const choiceLabel = (choice: OpenChoice): string =>
  choice.agent === undefined ? choice.opener.name : `${agentInfo(choice.agent).name} in ${choice.opener.name}`;

const ChoiceIcon = (props: { readonly choice: OpenChoice; readonly size?: number }): JSX.Element => {
  const agent = (): CodingAgent | undefined => props.choice.agent ?? props.choice.opener.agent;
  return (
    <Switch fallback={<CodeIcon size={props.size ?? 13} class="text-faint" />}>
      <Match when={agent()}>{(value) => <AgentLogo agent={value()} size={props.size ?? 13} />}</Match>
      <Match when={props.choice.opener.kind === "terminal"}>
        <TerminalIcon size={props.size ?? 13} class="text-faint" />
      </Match>
      <Match when={props.choice.opener.kind === "files"}>
        <FolderIcon size={props.size ?? 13} class="text-faint" />
      </Match>
    </Switch>
  );
};

/**
 * Top-bar Open: opens the project folder in the installed apps the service
 * found, and starts each configured coding agent's CLI in a terminal. The
 * last choice becomes the button's default.
 */
export const OpenInButton = (props: {
  readonly projectId: string;
  readonly projectName: string;
}): JSX.Element => {
  const store = useAgent();
  const [openers, setOpeners] = createSignal<ProjectOpeners>();
  const [open, setOpen] = createSignal(false);
  const [configuring, setConfiguring] = createSignal(false);
  const [lastKey, setLastKey] = createSignal(readChoice());
  let root: HTMLDivElement | undefined;

  const refresh = async (): Promise<void> => {
    const value = await store.listProjectOpeners(props.projectId);
    if (value !== undefined) setOpeners(value);
  };

  const all = (): ReadonlyArray<ProjectOpenerInfo> => openers()?.openers ?? [];
  const configured = (): ReadonlyArray<CodingAgent> => openers()?.configuredAgents ?? [];

  /** The terminal agents start in: the last one used for an agent, else the first that can. */
  const agentTerminal = createMemo<ProjectOpenerInfo | undefined>(() => {
    const capable = all().filter((opener) => opener.runsAgents);
    const last = lastKey()?.split(":")[0];
    return capable.find((opener) => opener.opener === last) ?? capable[0];
  });

  const agentApps = createMemo<ReadonlyArray<OpenChoice>>(() =>
    all().filter((opener) => opener.kind === "agent").map((opener) => ({ opener })),
  );
  /** Configured agents without their own app here run in the terminal. */
  const agentClis = createMemo<ReadonlyArray<OpenChoice>>(() => {
    const terminal = agentTerminal();
    if (terminal === undefined) return [];
    return configured().map((agent) => ({ opener: terminal, agent }));
  });
  const terminals = createMemo<ReadonlyArray<OpenChoice>>(() =>
    all().filter((opener) => opener.kind === "terminal").map((opener) => ({ opener })),
  );
  const editors = createMemo<ReadonlyArray<OpenChoice>>(() =>
    all().filter((opener) => opener.kind === "editor").map((opener) => ({ opener })),
  );
  const files = createMemo<ReadonlyArray<OpenChoice>>(() =>
    all().filter((opener) => opener.kind === "files").map((opener) => ({ opener })),
  );

  const primary = createMemo<OpenChoice | undefined>(() => {
    const choices = [...agentApps(), ...agentClis(), ...terminals(), ...editors(), ...files()];
    const stored = lastKey();
    const remembered = choices.find((choice) => choiceKey({ opener: choice.opener.opener, agent: choice.agent }) === stored);
    if (remembered !== undefined) return remembered;
    const configuredApp = agentApps().find(
      (choice) => choice.opener.agent !== undefined && configured().includes(choice.opener.agent),
    );
    return configuredApp ?? agentClis()[0] ?? choices[0];
  });

  const primaryTitle = (): string => {
    const choice = primary();
    return choice === undefined ? "Open the project folder" : `Open in ${choiceLabel(choice)}`;
  };

  const run = (choice: OpenChoice): void => {
    setOpen(false);
    const key = choiceKey({ opener: choice.opener.opener, agent: choice.agent });
    writeChoice(key);
    setLastKey(key);
    void store.openProject(props.projectId, choice.opener.opener, choice.agent);
  };

  onMount(() => {
    void refresh();
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

  const toggleMenu = (): void => {
    const next = !open();
    setOpen(next);
    if (next) void refresh();
  };

  const Item = (itemProps: {
    readonly choice: OpenChoice;
    readonly label?: string | undefined;
    readonly hint?: string;
  }): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      data-testid="open-in-option"
      data-opener={itemProps.choice.opener.opener}
      data-agent={itemProps.choice.agent}
      class="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-body hover:bg-hover"
      onClick={() => run(itemProps.choice)}
    >
      <span class="grid w-4 shrink-0 place-items-center">
        <ChoiceIcon choice={itemProps.choice} />
      </span>
      <span class="min-w-0 flex-1 truncate">{itemProps.label ?? itemProps.choice.opener.name}</span>
      <Show when={itemProps.hint}>
        <span class="shrink-0 text-[11px] text-faint">{itemProps.hint}</span>
      </Show>
    </button>
  );

  const Group = (groupProps: { readonly title: string; readonly children: JSX.Element }): JSX.Element => (
    <div class="mt-1 border-t border-edge pt-1 first:mt-0 first:border-t-0 first:pt-0">
      <p class="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-faint">{groupProps.title}</p>
      {groupProps.children}
    </div>
  );

  return (
    <div ref={root} class="relative flex items-center" data-testid="open-in">
      <Button
        size="small"
        variant="outline"
        class="h-7 rounded-r-none"
        data-testid="open-in-primary"
        title={primaryTitle()}
        disabled={primary() === undefined}
        loading={store.isPending(`project:${props.projectId}:open`)}
        icon={<Show when={primary()}>{(choice) => <ChoiceIcon choice={choice()} size={12} />}</Show>}
        onClick={() => {
          const choice = primary();
          if (choice !== undefined) run(choice);
        }}
      >
        Open
      </Button>
      <button
        type="button"
        data-testid="open-in-menu"
        aria-label="Open in…"
        aria-haspopup="menu"
        aria-expanded={open()}
        class={cx(
          "inline-flex h-7 w-6 items-center justify-center rounded-r-md border border-l-0 border-edge-strong text-muted transition-colors hover:bg-hover hover:text-body",
          open() && "bg-hover",
        )}
        onClick={toggleMenu}
      >
        <ChevronDownIcon size={12} />
      </button>
      <Show when={open()}>
        <div
          role="menu"
          data-testid="open-in-options"
          data-no-drag
          class="absolute right-0 top-8 z-40 w-[230px] rounded-md border border-edge-strong bg-layer p-1 shadow-[var(--v2-elevation-overlay)]"
        >
          <Show when={agentApps().length > 0 || agentClis().length > 0}>
            <Group title="Agents">
              <For each={agentApps()}>{(choice) => <Item choice={choice} hint="App" />}</For>
              <For each={agentClis()}>
                {(choice) => (
                  <Item
                    choice={choice}
                    label={choice.agent === undefined ? undefined : agentInfo(choice.agent).name}
                    hint={`in ${choice.opener.name}`}
                  />
                )}
              </For>
            </Group>
          </Show>
          <Show when={terminals().length > 0}>
            <Group title="Terminals">
              <For each={terminals()}>{(choice) => <Item choice={choice} />}</For>
            </Group>
          </Show>
          <Show when={editors().length > 0}>
            <Group title="Editors">
              <For each={editors()}>{(choice) => <Item choice={choice} />}</For>
            </Group>
          </Show>
          <Show when={files().length > 0}>
            <div class="mt-1 border-t border-edge pt-1 first:mt-0 first:border-t-0 first:pt-0">
              <For each={files()}>{(choice) => <Item choice={choice} />}</For>
            </div>
          </Show>
          <div class="mt-1 border-t border-edge pt-1">
            <button
              type="button"
              role="menuitem"
              data-testid="open-in-configure-agents"
              class="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-muted hover:bg-hover hover:text-body"
              onClick={() => {
                setOpen(false);
                setConfiguring(true);
              }}
            >
              <span class="grid w-4 shrink-0 place-items-center">
                <SettingsIcon size={13} class="text-faint" />
              </span>
              Configure agents…
            </button>
          </div>
        </div>
      </Show>
      <Show when={configuring()}>
        <AgentSetupDialog
          projectId={props.projectId}
          projectName={props.projectName}
          onClose={() => {
            setConfiguring(false);
            void refresh();
          }}
        />
      </Show>
    </div>
  );
};
