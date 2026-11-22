import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { CloudPairingSession } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import {
  formatDateTime,
  formatDuration,
  plural,
} from "../lib/format.ts";
import { ExternalLinkIcon, TrashIcon } from "../ui/icons.tsx";
import {
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  PageHeader,
  Section,
  Status,
  TextInput,
  cx,
} from "../ui/primitives.tsx";
import { setThemeSetting, themeSetting } from "../ui/theme.ts";
import type { ThemeSetting } from "../ui/theme.ts";

const themeOptions: ReadonlyArray<{ readonly value: ThemeSetting; readonly label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const machineNameKey = "ballast.machineName";

const readMachineName = (): string => {
  if (typeof window === "undefined") return "Studio PC";
  try {
    return window.localStorage.getItem(machineNameKey) ?? "Studio PC";
  } catch {
    return "Studio PC";
  }
};

const rememberMachineName = (value: string): void => {
  try {
    window.localStorage.setItem(machineNameKey, value);
  } catch {
    // Non-critical.
  }
};

export const SettingsScreen = (): JSX.Element => {
  const store = useAgent();
  const [path, setPath] = createSignal("");
  const [name, setName] = createSignal("");
  const [projectError, setProjectError] = createSignal<string>();
  const [removing, setRemoving] = createSignal<string>();
  const [stopOpen, setStopOpen] = createSignal(false);
  const [unpairOpen, setUnpairOpen] = createSignal(false);
  const [machineName, setMachineName] = createSignal(readMachineName());
  const [session, setSession] = createSignal<CloudPairingSession>();
  const [code, setCode] = createSignal("");

  const addProject = async (): Promise<void> => {
    const value = path().trim();
    if (value === "") {
      setProjectError("Enter the absolute path of a folder.");
      return;
    }
    store.clearActionError();
    const added = await store.addProject(value, name().trim());
    if (added === undefined) {
      setProjectError(store.lastActionError() ?? "Could not add the project.");
      return;
    }
    setProjectError(undefined);
    setPath("");
    setName("");
    store.selectProject(added.summary.id);
  };

  const beginPairing = async (): Promise<void> => {
    const machine = machineName().trim();
    if (machine === "") return;
    rememberMachineName(machine);
    const created = await store.beginCloudPairing(machine);
    if (created !== undefined) {
      setSession(created);
      setCode("");
    }
  };

  const confirmPairing = async (): Promise<void> => {
    if (code().trim() === "") return;
    const result = await store.pairCloud(code().trim(), machineName().trim());
    if (result !== undefined) {
      setSession(undefined);
      setCode("");
    }
  };

  const cloud = () => store.cloud();

  return (
    <div>
      <PageHeader title="Settings" description="Service, projects, cloud and appearance." />

      <Section title="Service">
        <div class="border-t border-edge">
          <SettingRow label="Version">
            <span class="font-mono">{store.info()?.version ?? "—"}</span>
          </SettingRow>
          <SettingRow label="API">
            <span class="font-mono">{store.info()?.apiVersion ?? "—"}</span>
          </SettingRow>
          <SettingRow label="Process">
            <span class="font-mono">
              {store.info()?.pid ?? "—"} · {store.info()?.platform ?? "—"}/
              {store.info()?.arch ?? "—"}
            </span>
          </SettingRow>
          <SettingRow label="Uptime">
            {store.health() === undefined ? "—" : formatDuration(store.health()?.uptimeMs ?? 0)}
          </SettingRow>
          <SettingRow label="Transport">
            <span class="font-mono">
              {store.transport.kind === "mock" ? "in-browser mock" : store.transport.label}
            </span>
          </SettingRow>
          <SettingRow label="Data">
            <span class="truncate font-mono text-[11px]">{store.info()?.dataDir ?? "—"}</span>
          </SettingRow>
        </div>
        <div class="mt-3 flex items-center gap-2">
          <Button
            variant="neutral"
            data-testid="service-restart"
            loading={store.isPending("service:restart")}
            onClick={() => void store.restartService("settings")}
          >
            Restart
          </Button>
          <Button
            variant="ghost"
            data-testid="service-stop"
            onClick={() => setStopOpen(true)}
          >
            Stop service
          </Button>
        </div>
        <Show when={store.transport.kind === "mock"}>
          <p class="mt-2 text-[11px] text-faint">
            Mock service: restart and stop are no-ops.
          </p>
        </Show>
      </Section>

      <Section title="Projects" description="Folders the agent watches. Removing one never deletes its files.">
        <div class="border-t border-edge">
          <For each={store.projects()}>
            {(project) => (
              <div class="flex items-center gap-3 border-b border-edge py-2">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[13px] text-strong">{project.name}</p>
                  <p class="truncate font-mono text-[11px] text-faint">{project.root}</p>
                </div>
                <span class="text-[11px] text-faint">
                  {plural(store.projectScriptCount(project.id), "script")}
                </span>
                <IconButton
                  label={`Remove ${project.name}`}
                  variant="ghost"
                  onClick={() => setRemoving(project.id)}
                >
                  <TrashIcon size={13} />
                </IconButton>
              </div>
            )}
          </For>
          <Show when={store.projects().length === 0}>
            <p class="py-3 text-[12px] text-muted">No projects yet.</p>
          </Show>
        </div>

        <div class="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Folder" class="min-w-48 flex-1">
            <TextInput
              data-testid="add-project-path"
              value={path()}
              onInput={(event) => setPath(event.currentTarget.value)}
              placeholder="/Users/you/streaming/my-channel"
            />
          </Field>
          <Field label="Name (optional)" class="w-36">
            <TextInput
              data-testid="add-project-name"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder="My channel"
            />
          </Field>
          <Button
            variant="neutral"
            data-testid="add-project-submit"
            loading={store.isPending("project:add")}
            onClick={() => void addProject()}
          >
            Add
          </Button>
        </div>
        <Show when={projectError()}>
          <p class="mt-1 text-[11px] text-danger">{projectError()}</p>
        </Show>
      </Section>

      <Section title="Cloud" description="One pairing per machine; every project shares it.">
        <div class="border-t border-edge">
          <SettingRow label="State">
            <Status tone={cloud()?.state === "linked" ? "success" : "neutral"}>
              {cloud()?.state ?? "unknown"}
            </Status>
          </SettingRow>
          <Show when={cloud()?.account}>
            {(account) => (
              <SettingRow label="Account">
                <span class="font-mono">@{account().login}</span>
              </SettingRow>
            )}
          </Show>
          <Show when={cloud()?.machine}>
            {(machine) => (
              <SettingRow label="Machine">{machine().name}</SettingRow>
            )}
          </Show>
          <Show when={cloud()?.pairedAt}>
            {(pairedAt) => (
              <SettingRow label="Paired">{formatDateTime(pairedAt())}</SettingRow>
            )}
          </Show>
        </div>

        <Show
          when={cloud()?.state === "linked"}
          fallback={
            <div class="mt-3 space-y-2">
              <div class="flex flex-wrap items-end gap-2">
                <Field label="Machine name" class="w-44">
                  <TextInput
                    data-testid="cloud-machine-name"
                    value={machineName()}
                    onInput={(event) => setMachineName(event.currentTarget.value)}
                    placeholder="Studio PC"
                  />
                </Field>
                <Button
                  variant="neutral"
                  data-testid="cloud-begin"
                  loading={store.isPending("cloud:begin")}
                  onClick={() => void beginPairing()}
                >
                  Pair
                </Button>
              </div>
              <Show when={session()}>
                {(pairing) => (
                  <div class="rounded-md border border-edge bg-layer px-3 py-2.5">
                    <div class="flex items-center gap-2 text-[12px]">
                      <span class="text-muted">Code</span>
                      <span class="font-mono text-[15px] tracking-widest text-strong">
                        {pairing().code}
                      </span>
                      <a
                        href={pairing().url}
                        target="_blank"
                        rel="noreferrer"
                        class="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        Open page <ExternalLinkIcon size={11} />
                      </a>
                    </div>
                    <p class="mt-1 text-[11px] text-muted">{pairing().instructions}</p>
                    <div class="mt-2 flex items-end gap-2">
                      <Field label="Code from the page" class="flex-1">
                        <TextInput
                          data-testid="cloud-pair-code"
                          value={code()}
                          onInput={(event) => setCode(event.currentTarget.value)}
                          placeholder="BCDF-2345"
                          class="font-mono uppercase tracking-wider"
                        />
                      </Field>
                      <Button
                        variant="primary"
                        data-testid="cloud-pair"
                        loading={store.isPending("cloud:pair")}
                        disabled={code().trim() === ""}
                        onClick={() => void confirmPairing()}
                      >
                        Confirm
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          }
        >
          <div class="mt-3 flex items-center gap-2">
            <Button
              variant="ghost"
              data-testid="cloud-unpair"
              onClick={() => setUnpairOpen(true)}
            >
              Unpair machine
            </Button>
          </div>
        </Show>
      </Section>

      <Section title="Appearance">
        <div class="flex items-center gap-1 border-t border-edge pt-3">
          <For each={themeOptions}>
            {(option) => (
              <button
                type="button"
                data-testid={`theme-${option.value}`}
                onClick={() => setThemeSetting(option.value)}
                class={cx(
                  "h-7 rounded-md px-3 text-[12px] transition-colors",
                  themeSetting() === option.value
                    ? "bg-hover text-strong"
                    : "text-muted hover:bg-hover hover:text-body",
                )}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Section>

      <Show when={stopOpen()}>
        <ConfirmDialog
          title="Stop the service?"
          description="Workers, connections and the cloud relay close. Scripts resume when it starts again."
          confirmLabel="Stop"
          pending={store.isPending("service:shutdown")}
          onCancel={() => setStopOpen(false)}
          onConfirm={() => {
            void store.shutdownService().then((ok) => {
              if (ok) setStopOpen(false);
            });
          }}
        />
      </Show>

      <Show when={unpairOpen()}>
        <ConfirmDialog
          title="Unpair this machine?"
          description="The machine token is removed and cloud mode stops. Local connections keep working."
          confirmLabel="Unpair"
          pending={store.isPending("cloud:unpair")}
          onCancel={() => setUnpairOpen(false)}
          onConfirm={() => {
            void store.unpairCloud().then((result) => {
              if (result !== undefined) setUnpairOpen(false);
            });
          }}
        />
      </Show>

      <Show when={removing()}>
        {(projectId) => {
          const project = () => store.project(projectId());
          return (
            <ConfirmDialog
              title={`Remove ${project()?.name ?? "project"}?`}
              description="The project is unregistered. Files on disk stay where they are."
              confirmLabel="Remove"
              pending={store.isPending("project:remove")}
              onCancel={() => setRemoving(undefined)}
              onConfirm={() => {
                void store.removeProject(projectId()).then((ok) => {
                  if (ok) setRemoving(undefined);
                });
              }}
            />
          );
        }}
      </Show>
    </div>
  );
};

const SettingRow = (props: {
  readonly label: string;
  readonly children: JSX.Element;
}): JSX.Element => (
  <div class="flex min-h-9 items-center justify-between gap-6 border-b border-edge py-1.5 text-[12px] last:border-b-0">
    <span class="text-muted">{props.label}</span>
    <span class="min-w-0 text-right text-body">{props.children}</span>
  </div>
);
