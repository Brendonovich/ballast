import { Match, Show, Switch, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ProjectDetail } from "@ballast/agent-protocol";

import { getDesktopBridge } from "../bridge.ts";
import { dismissOnboarding } from "../lib/onboarding.ts";
import { projectPath } from "../lib/routes.ts";
import { useAgent } from "../state/context.tsx";
import { ArrowLeftIcon, CodeIcon, ProjectsIcon } from "../ui/icons.tsx";
import type { IconProps } from "../ui/icons.tsx";
import { Button, Field, TextInput, cx, surface } from "../ui/primitives.tsx";
import { AgentSetup } from "./project/AgentSetup.tsx";
import { FolderPicker } from "./ProjectsScreen.tsx";

type Step =
  | { readonly kind: "choose" }
  | { readonly kind: "create" }
  | { readonly kind: "connect"; readonly project: ProjectDetail }
  | { readonly kind: "consume" };

/**
 * First-run onboarding, also reachable from Projects → Get started. A
 * creator makes a project and configures a coding agent to Ballast's MCP
 * server; a consumer subscribes to a share link or opens a local folder.
 */
export const OnboardingScreen = (): JSX.Element => {
  const navigate = useNavigate();
  const bridge = getDesktopBridge();
  const [step, setStep] = createSignal<Step>({ kind: "choose" });
  const connecting = () => {
    const current = step();
    return current.kind === "connect" ? current : undefined;
  };

  const leave = (): void => {
    dismissOnboarding();
    navigate("/projects", { replace: true });
  };

  const openProject = (projectId: string): void => {
    dismissOnboarding();
    if (bridge !== undefined) {
      void bridge.windows.openProjectWindow(projectId, { newWindow: false });
      return;
    }
    navigate(projectPath(projectId), { replace: true });
  };

  return (
    <div class="mx-auto w-full max-w-[640px] px-8 pb-12 pt-6" data-testid="onboarding">
      <div class="flex items-center justify-between">
        <Show when={step().kind === "create" || step().kind === "consume"} fallback={<span />}>
          <button
            type="button"
            data-testid="onboarding-back"
            class="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-body"
            onClick={() => setStep({ kind: "choose" })}
          >
            <ArrowLeftIcon size={13} /> Back
          </button>
        </Show>
        <Button variant="ghost" data-testid="onboarding-skip" onClick={leave}>
          {step().kind === "connect" ? "Close" : "Skip for now"}
        </Button>
      </div>

      <Switch>
        <Match when={step().kind === "choose"}>
          <header class="mt-10">
            <h1 class="text-[24px] font-medium leading-8 tracking-[-0.02em] text-strong">
              Welcome to Ballast
            </h1>
            <p class="mt-2 text-[13px] text-muted">
              Ballast runs projects on this machine that react to your stream: Twitch, OBS, VTube Studio,
              MIDI and more. What would you like to do?
            </p>
          </header>
          <div class="mt-8 grid gap-3 sm:grid-cols-2">
            <PathCard
              testId="onboarding-create"
              icon={CodeIcon}
              title="Build a project"
              description="Create a project and configure your coding agent for Ballast, then describe what it should do."
              onSelect={() => setStep({ kind: "create" })}
            />
            <PathCard
              testId="onboarding-consume"
              icon={ProjectsIcon}
              title="Use a shared project"
              description="Paste a share link someone sent you, or open a project folder you already have."
              onSelect={() => setStep({ kind: "consume" })}
            />
          </div>
        </Match>

        <Match when={step().kind === "create"}>
          <StepHeader
            index={1}
            title="Create a project"
            description="A project is a folder with a ballast.ts entry. Ballast watches it and starts it only when you say so."
          />
          <CreateStep onCreated={(project) => setStep({ kind: "connect", project })} />
        </Match>

        <Match when={connecting()}>
          {(current) => (
            <>
              <StepHeader index={2} title="Configure your coding agent" />
              <div class={cx(surface, "mt-6 p-4")}>
                <AgentSetup
                  projectId={current().project.summary.id}
                  projectName={current().project.summary.name}
                />
              </div>
              <div class="mt-6 flex justify-end">
                <Button
                  variant="primary"
                  data-testid="onboarding-open-project"
                  onClick={() => openProject(current().project.summary.id)}
                >
                  Open project
                </Button>
              </div>
            </>
          )}
        </Match>

        <Match when={step().kind === "consume"}>
          <header class="mt-8">
            <h1 class="text-[20px] font-medium leading-7 tracking-[-0.02em] text-strong">
              Use a shared project
            </h1>
          </header>
          <ConsumeStep onOpened={(project) => openProject(project.summary.id)} />
        </Match>
      </Switch>
    </div>
  );
};

const PathCard = (props: {
  readonly testId: string;
  readonly icon: (props: IconProps) => JSX.Element;
  readonly title: string;
  readonly description: string;
  readonly onSelect: () => void;
}): JSX.Element => (
  <button
    type="button"
    data-testid={props.testId}
    class={cx(surface, "flex flex-col items-start gap-2 p-4 text-left transition-colors hover:bg-hover")}
    onClick={props.onSelect}
  >
    <props.icon size={18} class="text-muted" />
    <span class="text-[14px] font-medium text-strong">{props.title}</span>
    <span class="text-[12px] text-muted">{props.description}</span>
  </button>
);

const StepHeader = (props: {
  readonly index: number;
  readonly title: string;
  readonly description?: string;
}): JSX.Element => (
  <header class="mt-8">
    <p class="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
      Step {props.index} of 2
    </p>
    <h1 class="mt-1 text-[20px] font-medium leading-7 tracking-[-0.02em] text-strong">
      {props.title}
    </h1>
    <Show when={props.description}>
      <p class="mt-1 break-words text-[13px] text-muted">{props.description}</p>
    </Show>
  </header>
);

const CreateStep = (props: { readonly onCreated: (project: ProjectDetail) => void }): JSX.Element => {
  const store = useAgent();
  const [name, setName] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [error, setError] = createSignal<string>();

  const create = async (): Promise<void> => {
    if (name().trim() === "") {
      setError("Enter a project name.");
      return;
    }
    setError(undefined);
    store.clearActionError();
    const detail = await store.createProject(name(), directory());
    if (detail === undefined) {
      setError(store.lastActionError() ?? "Could not create the project.");
      return;
    }
    props.onCreated(detail);
  };

  return (
    <div class={cx(surface, "mt-6 space-y-3 p-4")}>
      <Field label="Name">
        <TextInput
          data-testid="onboarding-project-name"
          value={name()}
          autofocus
          placeholder="My channel"
          onInput={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
      </Field>
      <FolderPicker value={directory()} onChange={setDirectory} testId="onboarding-project-directory" />
      <Show when={error()}>
        <p class="text-[11px] text-danger">{error()}</p>
      </Show>
      <div class="flex justify-end pt-1">
        <Button
          variant="primary"
          data-testid="onboarding-create-submit"
          loading={store.isPending("project:create")}
          onClick={() => void create()}
        >
          Create project
        </Button>
      </div>
    </div>
  );
};

const ConsumeStep = (props: { readonly onOpened: (project: ProjectDetail) => void }): JSX.Element => {
  const store = useAgent();
  const [link, setLink] = createSignal("");
  const [shareDirectory, setShareDirectory] = createSignal("");
  const [shareError, setShareError] = createSignal<string>();
  const [folder, setFolder] = createSignal("");
  const [folderError, setFolderError] = createSignal<string>();

  onMount(() => {
    if (store.shareServers() === undefined) void store.loadShareServers();
  });

  const subscribe = async (): Promise<void> => {
    if (link().trim() === "") {
      setShareError("Paste the share link or code you were given.");
      return;
    }
    setShareError(undefined);
    store.clearActionError();
    const detail = await store.subscribeProject(link(), shareDirectory());
    if (detail === undefined) {
      setShareError(store.lastActionError() ?? "Could not subscribe.");
      return;
    }
    props.onOpened(detail);
  };

  const openFolder = async (): Promise<void> => {
    if (folder().trim() === "") {
      setFolderError("Choose the project's folder.");
      return;
    }
    setFolderError(undefined);
    store.clearActionError();
    const detail = await store.addProject(folder().trim());
    if (detail === undefined) {
      setFolderError(store.lastActionError() ?? "Could not open the folder.");
      return;
    }
    props.onOpened(detail);
  };

  return (
    <div class="mt-6 space-y-4">
      <section class={cx(surface, "space-y-3 p-4")} data-testid="onboarding-share">
        <div>
          <h2 class="text-[14px] font-medium text-strong">Paste a share link</h2>
          <p class="mt-1 text-[12px] text-muted">
            Ballast downloads a read-only copy that starts stopped. You choose when to start it and when to
            apply updates. Shared projects run without a sandbox, so only use ones from people you trust.
          </p>
        </div>
        <Field label="Share link or code">
          <TextInput
            data-testid="onboarding-share-link"
            value={link()}
            autofocus
            placeholder="https://…/s/ABCD-EFGH-JKLM"
            onInput={(event) => setLink(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void subscribe();
            }}
          />
        </Field>
        <FolderPicker value={shareDirectory()} onChange={setShareDirectory} testId="onboarding-share-directory" />
        <Show when={shareError()}>
          <p class="text-[11px] text-danger">{shareError()}</p>
        </Show>
        <div class="flex justify-end">
          <Button
            variant="primary"
            data-testid="onboarding-subscribe"
            loading={store.isPending("project:subscribe")}
            onClick={() => void subscribe()}
          >
            Get project
          </Button>
        </div>
      </section>

      <div class="flex items-center gap-3 text-[11px] text-faint">
        <span class="h-px flex-1 bg-[var(--v2-border-border-base)]" />
        or
        <span class="h-px flex-1 bg-[var(--v2-border-border-base)]" />
      </div>

      <section class={cx(surface, "space-y-3 p-4")} data-testid="onboarding-local">
        <div>
          <h2 class="text-[14px] font-medium text-strong">Open a local project</h2>
          <p class="mt-1 text-[12px] text-muted">A folder with a ballast.ts entry, for example one you copied or cloned.</p>
        </div>
        <FolderPicker
          value={folder()}
          onChange={setFolder}
          testId="onboarding-local-folder"
          label="Folder"
          placeholder="/Users/you/ballast-projects/my-channel"
        />
        <Show when={folderError()}>
          <p class="text-[11px] text-danger">{folderError()}</p>
        </Show>
        <div class="flex justify-end">
          <Button
            variant="neutral"
            data-testid="onboarding-open-folder"
            loading={store.isPending("project:add")}
            onClick={() => void openFolder()}
          >
            Open folder
          </Button>
        </div>
      </section>
    </div>
  );
};
