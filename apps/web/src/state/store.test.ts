import { afterEach, describe, expect, it } from "vitest";

import { createAgentRuntime } from "../agent/client.ts";
import type { AgentRuntime } from "../agent/client.ts";
import { createAgentStore } from "./store.ts";
import type { AgentStore } from "./store.ts";

const main = "proj_main";

interface Harness {
  readonly runtime: AgentRuntime;
  readonly store: AgentStore;
}

const harnesses: Array<Harness> = [];

const setup = async (): Promise<Harness> => {
  const runtime = await createAgentRuntime({ kind: "mock", label: "test mock" });
  const store = createAgentStore(runtime);
  const harness = { runtime, store };
  harnesses.push(harness);
  store.start();
  await store.whenReady();
  return harness;
};

const waitFor = async (
  predicate: () => boolean,
  message: string,
  timeout = 4_000,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
};

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) await harness.store.dispose();
  }
});

describe("agent store against MockAgentLayer", () => {
  it("records a rejected action's error in lastActionError", async () => {
    const { store } = await setup();

    const added = await store.addProject("relative/folder");
    expect(added).toBeUndefined();
    expect(store.lastActionError()).toContain("must be absolute");
  });

  it("applies project changes made by another client", async () => {
    const { runtime, store } = await setup();

    expect(store.project(main)).not.toBeUndefined();
    await runtime.run(runtime.client.RemoveProject({ projectId: main }));
    await waitFor(
      () => store.project(main) === undefined,
      "the project-removed event",
    );
    expect(store.projects().map((project) => project.id)).not.toContain(main);
  });
});
