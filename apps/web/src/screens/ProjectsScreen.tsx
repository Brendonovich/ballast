import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ProjectDetail, ProjectSummary } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { getDesktopBridge } from "../bridge.ts";
import { plural } from "../lib/format.ts";
import {
  actionLabel,
  issueSummary,
  projectAction,
  sortIssues,
  statusLabel,
  statusTone,
} from "../lib/project-health.ts";
import { requestProjectIntent } from "../lib/project-intent.ts";
import {
  ONBOARDING_PATH,
  onboardingDismissed,
  shouldAutoOpenOnboarding,
} from "../lib/onboarding.ts";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
  Status,
  StatusDot,
  TextInput,
  cx,
} from "../ui/primitives.tsx";

const shareLabel = (project: ProjectSummary): string | undefined => {
  const share = project.share;
  if (share === undefined) return undefined;
  if (share._tag === "shared") return "Shared";
  return share.available === undefined ? "Subscribed" : "Update available";
};

const projectHref = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}`;

export const ProjectsScreen = (): JSX.Element => {
  const store = useAgent();
  const navigate = useNavigate();
  const bridge = getDesktopBridge();
  const [newOpen, setNewOpen] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [subscribeOpen, setSubscribeOpen] = createSignal(false);

  onMount(() => {
    if (shouldAutoOpenOnboarding(store.projects().length, onboardingDismissed())) {
      navigate(ONBOARDING_PATH, { replace: true });
    }
  });

  const open = (projectId: string, options?: { readonly newWindow?: boolean }): void => {
    if (bridge !== undefined) {
      void bridge.windows.openProjectWindow(projectId, {
        newWindow: options?.newWindow === true,
      });
      return;
    }
    if (options?.newWindow === true) {
      const url = new URL(window.location.href);
      url.hash = projectHref(projectId);
      window.open(url.toString(), "_blank", "noopener");
      return;
    }
    navigate(projectHref(projectId));
  };

  const toggle = async (project: ProjectSummary): Promise<void> => {
    switch (projectAction(project.status)) {
      case "set-up":
        // The project view owns the binding and consent flow.
        requestProjectIntent(project.id, { kind: "set-up" });
        open(project.id);
        return;
      case "stop":
        await store.stopProject(project.id);
        return;
      case "start":
        await store.startProject(project.id);
        return;
    }
  };

  /** One line per issue for the row's tooltip. */
  const issuesTooltip = (project: ProjectSummary): string =>
    sortIssues(project.issues)
      .map((issue) => issue.title)
      .join("\n");

  return (
    <div>
      <PageHeader
        title="Projects"
        description="One bundle per project. Nothing starts automatically."
        actions={
          <>
            <Button
              variant="ghost"
              data-testid="open-onboarding"
              onClick={() => navigate(ONBOARDING_PATH)}
            >
              Get started
            </Button>
            <Button
              variant="ghost"
              data-testid="subscribe-project"
              onClick={() => setSubscribeOpen(true)}
            >
              Subscribe
            </Button>
            <Button variant="ghost" data-testid="add-project" onClick={() => setAddOpen(true)}>
              Add folder
            </Button>
            <Button
              variant="primary"
              data-testid="new-project"
              onClick={() => setNewOpen(true)}
            >
              New project
            </Button>
          </>
        }
      />

      <Show
        when={store.projects().length > 0}
        fallback={
          <EmptyState
            title="No projects yet"
            description="Build one with your coding agent, or use a project someone shared with you."
            action={
              <Button variant="neutral" onClick={() => navigate(ONBOARDING_PATH)}>
                Get started
              </Button>
            }
          />
        }
      >
        <div class="mt-6 border-t border-edge">
          <For each={store.projects()}>
            {(project) => (
              <div
                data-testid="project-row"
                data-project-id={project.id}
                data-status={project.status}
                class="group flex min-h-14 items-center gap-3 border-b border-edge py-2"
              >
                <StatusDot tone={statusTone(project)} class="ml-1" />
                <button
                  type="button"
                  data-testid="project-open"
                  class="min-w-0 flex-1 rounded-sm py-1 text-left"
                  onClick={(event) =>
                    open(project.id, {
                      newWindow: event.metaKey || event.ctrlKey,
                    })
                  }
                >
                  <span class="block truncate text-[13px] font-medium text-strong group-hover:text-accent">
                    {project.name}
                  </span>
                  <span class="block truncate font-mono text-[11px] text-faint">
                    {project.root}
                  </span>
                </button>
                <Show when={shareLabel(project)}>
                  {(label) => (
                    <span
                      data-testid="project-share"
                      class={cx(
                        "shrink-0 text-[11px]",
                        label() === "Update available" ? "text-warning" : "text-faint",
                      )}
                    >
                      {label()}
                    </span>
                  )}
                </Show>
                <span class="hidden text-[11px] text-faint sm:block">
                  {plural(project.unitCount, "unit")}
                </span>
                <Show when={project.issues.length > 0 && project.status !== "needs-user"}>
                  <span
                    data-testid="project-issue-count"
                    title={issuesTooltip(project)}
                    class={cx(
                      "shrink-0 text-[11px]",
                      project.issues.some((issue) => issue.severity === "error")
                        ? "text-danger"
                        : "text-warning",
                    )}
                  >
                    {issueSummary(project.issues)}
                  </span>
                </Show>
                <Status tone={statusTone(project)}>
                  <span data-testid="project-status-word">{statusLabel(project)}</span>
                </Status>
                <Button
                  size="small"
                  variant={projectAction(project.status) === "start" ? "neutral" : "outline"}
                  data-testid="project-action"
                  loading={
                    store.isPending(`project:${project.id}:start`) ||
                    store.isPending(`project:${project.id}:stop`)
                  }
                  onClick={() => void toggle(project)}
                >
                  {actionLabel(projectAction(project.status))}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={newOpen()}>
        <NewProjectDialog
          onClose={() => setNewOpen(false)}
          onCreated={(detail) => {
            setNewOpen(false);
            open(detail.summary.id);
          }}
        />
      </Show>

      <Show when={subscribeOpen()}>
        <SubscribeDialog
          onClose={() => setSubscribeOpen(false)}
          onSubscribed={(detail) => {
            setSubscribeOpen(false);
            open(detail.summary.id);
          }}
        />
      </Show>

      <Show when={addOpen()}>
        <AddProjectDialog
          onClose={() => setAddOpen(false)}
          onAdded={(detail) => {
            setAddOpen(false);
            open(detail.summary.id);
          }}
        />
      </Show>
    </div>
  );
};

export const FolderPicker = (props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly label?: string;
  readonly placeholder?: string;
}): JSX.Element => {
  const bridge = getDesktopBridge();
  const choose = async (): Promise<void> => {
    if (bridge === undefined) return;
    try {
      const picked = await bridge.app.pickDirectory();
      if (picked !== null) props.onChange(picked);
    } catch {
      // A cancelled or unavailable picker leaves the typed path intact.
    }
  };

  return (
    <div class="flex items-end gap-2">
      <Field label={props.label ?? "Folder (optional)"} class="min-w-0 flex-1">
        <TextInput
          data-testid={props.testId}
          value={props.value}
          placeholder={props.placeholder ?? "Defaults to ~/ballast-projects"}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      </Field>
      <Show when={bridge !== undefined}>
        <Button
          variant="outline"
          data-testid={`${props.testId}-pick`}
          onClick={() => void choose()}
        >
          Choose
        </Button>
      </Show>
    </div>
  );
};

export const NewProjectDialog = (props: {
  readonly onClose: () => void;
  readonly onCreated: (detail: ProjectDetail) => void;
}): JSX.Element => {
  const store = useAgent();
  const [name, setName] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [error, setError] = createSignal<string>();

  const create = async (): Promise<void> => {
    if (name().trim() === "") {
      setError("Enter a project name.");
      return;
    }
    store.clearActionError();
    const detail = await store.createProject(name(), directory());
    if (detail === undefined) {
      setError(store.lastActionError() ?? "Could not create the project.");
      return;
    }
    props.onCreated(detail);
  };

  return (
    <Dialog
      title="New project"
      description="Scaffolds ballast.ts in a new folder. The project starts stopped."
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="create-project-submit"
            loading={store.isPending("project:create")}
            onClick={() => void create()}
          >
            Create
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <Field label="Name">
          <TextInput
            data-testid="create-project-name"
            value={name()}
            autofocus
            placeholder="My channel"
            onInput={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
          />
        </Field>
        <FolderPicker
          value={directory()}
          onChange={setDirectory}
          testId="create-project-directory"
        />
        <Show when={error()}>
          <p class="text-[11px] text-danger">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
};

const SubscribeDialog = (props: {
  readonly onClose: () => void;
  readonly onSubscribed: (detail: ProjectDetail) => void;
}): JSX.Element => {
  const store = useAgent();
  const [code, setCode] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [error, setError] = createSignal<string>();

  const subscribe = async (): Promise<void> => {
    if (code().trim() === "") {
      setError("Enter the share link or code you were given.");
      return;
    }
    store.clearActionError();
    const detail = await store.subscribeProject(code(), directory());
    if (detail === undefined) {
      setError(store.lastActionError() ?? "Could not subscribe.");
      return;
    }
    props.onSubscribed(detail);
  };

  return (
    <Dialog
      title="Subscribe to a project"
      description="Downloads a read-only copy of someone's shared project. It starts stopped, and you choose when to apply updates. Scripts from others run on this machine without a sandbox, so only subscribe to people you trust."
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="subscribe-project-submit"
            loading={store.isPending("project:subscribe")}
            onClick={() => void subscribe()}
          >
            Subscribe
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <Field label="Share link or code">
          <TextInput
            data-testid="subscribe-share-code"
            value={code()}
            autofocus
            placeholder="https://…/s/ABCD-EFGH-JKLM"
            onInput={(event) => setCode(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void subscribe();
            }}
          />
        </Field>
        <FolderPicker value={directory()} onChange={setDirectory} testId="subscribe-directory" />
        <Show when={error()}>
          <p class="text-[11px] text-danger">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
};

const AddProjectDialog = (props: {
  readonly onClose: () => void;
  readonly onAdded: (detail: ProjectDetail) => void;
}): JSX.Element => {
  const store = useAgent();
  const [path, setPath] = createSignal("");
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string>();

  const add = async (): Promise<void> => {
    if (path().trim() === "") {
      setError("Enter the absolute path of a folder.");
      return;
    }
    store.clearActionError();
    const detail = await store.addProject(path(), name());
    if (detail === undefined) {
      setError(store.lastActionError() ?? "Could not add the project.");
      return;
    }
    props.onAdded(detail);
  };

  return (
    <Dialog
      title="Add existing folder"
      description="Watches a folder that already has a ballast.ts bundle."
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="add-project-submit"
            loading={store.isPending("project:add")}
            onClick={() => void add()}
          >
            Add
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <FolderPicker value={path()} onChange={setPath} testId="add-project-path" />
        <Field label="Name (optional)">
          <TextInput
            data-testid="add-project-name"
            value={name()}
            placeholder="My channel"
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </Field>
        <Show when={error()}>
          <p class="text-[11px] text-danger">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
};
