import { render } from "solid-js/web";
import type { JSX } from "solid-js";

import "./styles.css";
import { App } from "./App.tsx";
import { createAgentRuntime, resolvePageTransport } from "./agent/client.ts";
import type { TransportConfig } from "./agent/client.ts";
import { errorMessage } from "./agent/errors.ts";
import { createAgentStore } from "./state/store.ts";
import type { AgentStore } from "./state/store.ts";
import type { LogLevel } from "@ballast/agent-protocol";
import { ProjectConsentRequest } from "@ballast/agent-protocol";
import { Schema } from "effect";
import { toast } from "./ui/toast.tsx";
import { initialiseTheme } from "./ui/theme.ts";
import { resetOnboarding, testOnboarding } from "./lib/onboarding.ts";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The #root element is missing from index.html");
}

initialiseTheme();

const projectIdFromHash = (): string | undefined => {
  const match = /^#\/projects\/([^/?#]+)/.exec(window.location.hash);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const logLevels: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"];
const isLogLevel = (value: unknown): value is LogLevel =>
  logLevels.some((level) => level === value);

/** What `ballastMock.project` may attach; validated so a bad fixture fails loudly. */
const ProjectFixtureInput = Schema.Struct({
  pendingConsent: Schema.optionalKey(ProjectConsentRequest),
});
const decodeFixture = Schema.decodeUnknownSync(ProjectFixtureInput);

/**
 * Mock mode only: `window.ballastMock.log({ level, message })` appends a line
 * to the current project's logs, so e2e tests can exercise live log UI.
 */
const installMockHooks = (store: AgentStore): void => {
  Reflect.set(window, "ballastMock", {
    /**
     * `ballastMock.project(id, { pendingConsent })` attaches the consent the
     * mock lists but leaves off the detail; `null` clears it.
     */
    project: (projectId: unknown, input: unknown): void => {
      if (typeof projectId !== "string") throw new Error("a project id is required");
      store.setProjectFixture(projectId, input === null ? undefined : decodeFixture(input));
    },
    log: (input: unknown): void => {
      const projectId = projectIdFromHash();
      if (projectId === undefined || typeof input !== "object" || input === null) return;
      const level: unknown = Reflect.get(input, "level");
      const message: unknown = Reflect.get(input, "message");
      if (!isLogLevel(level) || typeof message !== "string") return;
      const seq = (store.logs().at(-1)?.seq ?? 0) + 1;
      store.receiveLog({ seq, at: Date.now(), level, source: "worker", message, projectId });
    },
  });
};

const mount = (view: () => JSX.Element): void => {
  rootElement.replaceChildren();
  render(view, rootElement);
};

const boot = async (): Promise<void> => {
  if (testOnboarding) resetOnboarding();
  const transport = await resolvePageTransport();
  try {
    const runtime = await createAgentRuntime(transport);
    const logProjectId = projectIdFromHash();
    const store = createAgentStore(runtime, {
      onError: (message) => toast.error("Request failed", message),
      ...(logProjectId === undefined ? {} : { logProjectId }),
    });
    store.start();
    if (transport.kind === "mock") installMockHooks(store);
    mount(() => <App store={store} />);
  } catch (error) {
    mount(() => <BootError transport={transport} message={errorMessage(error)} />);
  }
};

const BootError = (props: {
  readonly transport: TransportConfig;
  readonly message: string;
}): JSX.Element => (
  <div class="flex min-h-screen items-center justify-center p-8">
    <div class="max-w-sm text-center">
      <p class="text-[13px] font-medium text-strong">Ballast could not start</p>
      <p class="mt-1 text-[12px] text-muted">
        The renderer failed while building its agent connection for {props.transport.label}.
      </p>
      <p class="mt-3 break-all rounded-md border border-edge bg-layer px-2.5 py-2 font-mono text-[10px] text-danger">
        {props.message}
      </p>
      <a
        href={window.location.pathname}
        class="mt-4 inline-flex h-7 items-center rounded-md border border-edge-strong px-2.5 text-[13px] text-body hover:bg-hover"
      >
        Retry
      </a>
    </div>
  </div>
);

void boot();
