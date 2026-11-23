import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ProjectDetail, ProjectSummary } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { getDesktopBridge } from "../bridge.ts";
import {
  blockingRequirements,
  plural,
  projectStatusLabel,
  projectStatusTone,
  projectWorkerRunning,
} from "../lib/format.ts";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
  Status,
  StatusDot,
  TextInput,
} from "../ui/primitives.tsx";

const projectHref = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}`;

const statusLabelFor = (project: ProjectSummary): string => {
  if (project.status === "error" && project.enabled) return "Running previous version";
  return projectStatusLabel(project);
};

export const ProjectsScreen = (): JSX.Element => {
  const store = useAgent();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const requested = new Map<string, number>();

  createEffect(() => {
    for (const project of store.projects()) {
      const revision = store.projectRevision(project.id);
      const detail = store.projectDetail(project.id);
      if (detail !== undefined && requested.get(project.id) === revision) continue;
      requested.set(project.id, revision);
      void store.fetchProject(project.id, true);
    }
  });

  const open = (projectId: string): void => {
    navigate(projectHref(projectId));
  };

  const needsConsent = (project: ProjectSummary): boolean =>
    store.projectConsent(project.id) !== undefined;
  const needsConnections = (project: ProjectSummary): boolean => {
    const detail = store.projectDetail(project.id);
    return detail !== undefined && blockingRequirements(detail.requirements).length > 0;
  };
  const statusLabel = (project: ProjectSummary): string => {
    if (needsConnections(project)) return "Needs connections";
    if (needsConsent(project)) return "Needs consent";
    return statusLabelFor(project);
  };
  const statusTone = (project: ProjectSummary): "warning" | "success" | "danger" | "neutral" | "info" => {
    if (needsConsent(project) || needsConnections(project)) return "warning";
    return projectStatusTone(project);
  };

  const toggle = async (project: ProjectSummary): Promise<void> => {
    if (
      project.status === "needs-consent" ||
      needsConsent(project) ||
      needsConnections(project)
    ) {
      open(project.id);
      return;
    }
    if (projectWorkerRunning(project)) {
      await store.stopProject(project.id);
    } else {
      await store.startProject(project.id);
    }
  };

  const actionLabel = (project: ProjectSummary): string => {
    if (project.status === "needs-consent" || needsConsent(project) || needsConnections(project)) {
      return "Review";
    }
    return projectWorkerRunning(project) ? "Stop" : "Start";
  };

  return (
    <div>
      <PageHeader
        title="Projects"
        description="One bundle per project. Nothing starts automatically."
        actions={
          <>
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
            description="Create a bundle or watch an existing folder to get started."
            action={
              <Button variant="neutral" onClick={() => setNewOpen(true)}>
                New project
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
                data-status={
                  needsConnections(project)
                    ? "needs-connections"
                    : needsConsent(project)
                      ? "needs-consent"
                      : project.status
                }
                class="group flex min-h-14 items-center gap-3 border-b border-edge py-2"
              >
                <StatusDot tone={statusTone(project)} class="ml-1" />
                <button
                  type="button"
                  class="min-w-0 flex-1 rounded-sm py-1 text-left"
                  onClick={() => open(project.id)}
                >
                  <span class="block truncate text-[13px] font-medium text-strong group-hover:text-accent">
                    {project.name}
                  </span>
                  <span class="block truncate font-mono text-[11px] text-faint">
                    {project.root}
                  </span>
                </button>
                <span class="hidden text-[11px] text-faint sm:block">
                  {plural(project.unitCount, "unit")}
                </span>
                <Status tone={statusTone(project)}>{statusLabel(project)}</Status>
                <Button
                  size="small"
                  variant={
                    projectWorkerRunning(project) || project.status === "needs-consent"
                      ? "outline"
                      : "neutral"
                  }
                  loading={
                    store.isPending(`project:${project.id}:start`) ||
                    store.isPending(`project:${project.id}:stop`)
                  }
                  onClick={() => void toggle(project)}
                >
                  {actionLabel(project)}
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

const FolderPicker = (props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
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
      <Field label="Folder (optional)" class="min-w-0 flex-1">
        <TextInput
          data-testid={props.testId}
          value={props.value}
          placeholder="Defaults to ~/ballast-projects"
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

const NewProjectDialog = (props: {
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
