import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { CloudPairingSession } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { getDesktopBridge } from "../bridge.ts";
import type { ServiceAction, ServiceStatus } from "../bridge.ts";
import { formatDateTime, formatDuration } from "../lib/format.ts";
import { ExternalLinkIcon } from "../ui/icons.tsx";
import {
  Button,
  ConfirmDialog,
  Field,
  PageHeader,
  Section,
  Status,
  TextInput,
  cx,
} from "../ui/primitives.tsx";
import { toast } from "../ui/toast.tsx";
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
  const bridge = getDesktopBridge();
  const [desktopStatus, setDesktopStatus] = createSignal<ServiceStatus>();
  const [desktopBusy, setDesktopBusy] = createSignal<"restart" | "stop">();
  const [stopOpen, setStopOpen] = createSignal(false);
  const [unpairOpen, setUnpairOpen] = createSignal(false);
  const [machineName, setMachineName] = createSignal(readMachineName());
  const [session, setSession] = createSignal<CloudPairingSession>();
  const [code, setCode] = createSignal("");

  onMount(() => {
    if (bridge === undefined) return;
    void bridge.service
      .status()
      .then(setDesktopStatus)
      .catch(() => setDesktopStatus(undefined));
    const unsubscribe = bridge.events.onServiceStatus(setDesktopStatus);
    onCleanup(unsubscribe);
  });

  const desktopAction = async (
    kind: "restart" | "stop",
    action: () => Promise<ServiceAction>,
    failure: string,
  ): Promise<boolean> => {
    if (bridge === undefined) return false;
    setDesktopBusy(kind);
    try {
      const result = await action();
      setDesktopStatus(result.status);
      if (!result.ok) {
        toast.error(failure, result.message ?? "The desktop app could not control the service.");
      }
      return result.ok;
    } catch (error) {
      toast.error(failure, error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setDesktopBusy(undefined);
    }
  };

  // Restart is stop + spawn, which only the desktop app (or CLI) can do.
  const restartService = async (): Promise<void> => {
    if (bridge === undefined) return;
    await desktopAction("restart", () => bridge.service.restart(), "Restart failed");
  };

  const stopService = async (): Promise<void> => {
    if (bridge !== undefined) {
      const ok = await desktopAction("stop", () => bridge.service.stop(), "Stop failed");
      if (ok) setStopOpen(false);
      return;
    }
    const ok = await store.shutdownService();
    if (ok) setStopOpen(false);
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
      <PageHeader title="Settings" description="Service, cloud and appearance." />

      <Section title="Service">
        <Show
          when={desktopStatus()}
          fallback={
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
          }
        >
          {(status) => (
            <div class="border-t border-edge">
              <SettingRow label="State">
                <Status
                  tone={
                    status().running
                      ? "success"
                      : status().phase === "error"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {status().phase}
                </Status>
              </SettingRow>
              <SettingRow label="Running">
                {status().running ? "yes" : "no"}
              </SettingRow>
              <SettingRow label="Version">
                <span class="font-mono">
                  {status().runningVersion ??
                    status().builtVersion ??
                    store.info()?.version ??
                    "—"}
                </span>
              </SettingRow>
              <SettingRow label="Transport">
                <span class="font-mono">
                  {store.transport.kind === "mock" ? "in-browser mock" : store.transport.label}
                </span>
              </SettingRow>
              <SettingRow label="Data">
                <span class="truncate font-mono text-[11px]">{status().paths.dataDir}</span>
              </SettingRow>
            </div>
          )}
        </Show>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Show when={bridge !== undefined}>
            <Button
              variant="neutral"
              data-testid="service-restart"
              loading={desktopBusy() === "restart"}
              onClick={() => void restartService()}
            >
              Restart
            </Button>
          </Show>
          <Button
            variant="ghost"
            data-testid="service-stop"
            onClick={() => setStopOpen(true)}
          >
            Stop service
          </Button>
        </div>
        <Show when={bridge === undefined && store.transport.kind === "mock"}>
          <p class="mt-2 text-[11px] text-faint">
            Mock service: stop is a no-op.
          </p>
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
          description="Workers, connections and the cloud relay close. Projects resume when it starts again."
          confirmLabel="Stop"
          pending={desktopBusy() === "stop" || store.isPending("service:shutdown")}
          onCancel={() => setStopOpen(false)}
          onConfirm={() => void stopService()}
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
