import { render } from "solid-js/web";
import type { JSX } from "solid-js";

import "./styles.css";
import { App } from "./App.tsx";
import { createAgentRuntime, resolveTransport } from "./agent/client.ts";
import type { TransportConfig } from "./agent/client.ts";
import { errorMessage } from "./agent/errors.ts";
import { createAgentStore } from "./state/store.ts";
import { toast } from "./ui/toast.tsx";
import { initialiseTheme } from "./ui/theme.ts";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The #root element is missing from index.html");
}

initialiseTheme();

const mount = (view: () => JSX.Element): void => {
  rootElement.replaceChildren();
  render(view, rootElement);
};

const boot = async (): Promise<void> => {
  const transport = resolveTransport();
  try {
    const runtime = await createAgentRuntime(transport);
    const store = createAgentStore(runtime, {
      onError: (message) => toast.error("Request failed", message),
    });
    store.start();
    window.addEventListener("beforeunload", () => {
      void store.dispose();
    });
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
