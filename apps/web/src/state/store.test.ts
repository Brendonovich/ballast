import { afterEach, describe, expect, it } from "vitest";

import { createAgentRuntime } from "../agent/client.ts";
import type { AgentRuntime } from "../agent/client.ts";
import { createAgentStore } from "./store.ts";
import type { AgentStore } from "./store.ts";

const main = "proj_main";
const alt = "proj_alt";
const redeem = "scripts/redeem-to-scene.ts";
const cheer = "scripts/cheer-alert.ts";
const tick = "scripts/tick-echo.ts";

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
  it("loads the snapshot and selects the default project", async () => {
    const { store } = await setup();

    expect(store.watchStatus()).toBe("live");
    expect(store.info()?.name).toBe("ballast-agent");
    expect(store.info()?.apiVersion).toBe(1);
    expect(store.projects().map((project) => project.name)).toEqual([
      "Main Channel",
      "Second Channel",
    ]);
    expect(store.selectedProjectId()).toBe(main);
    expect(store.visibleScripts().map((script) => script.name)).toEqual([
      "Cheer Alert",
      "Redeem to Scene",
    ]);
    expect(store.health()?.scripts.total).toBe(4);
    expect(store.consents().map((consent) => consent.id)).toEqual(["consent-cheer"]);
  });

  it("switches between one project and all projects", async () => {
    const { store } = await setup();

    store.selectProject(alt);
    expect(store.currentProject()?.name).toBe("Second Channel");
    expect(store.visibleScripts().map((script) => script.id)).toEqual([
      "scripts/scene-rotation.ts",
      tick,
    ]);

    store.selectProject("all");
    expect(store.currentProject()).toBeUndefined();
    expect(store.visibleScripts()).toHaveLength(4);
  });

  it("adds and removes projects, leaving files alone", async () => {
    const { store } = await setup();

    const added = await store.addProject("/Users/streamer/Ballast/guest", "Guest");
    expect(added?.summary.id).toBe("proj_3");
    expect(store.projects().map((project) => project.name)).toContain("Guest");
    expect(store.projectScriptCount("proj_3")).toBe(0);

    store.selectProject("proj_3");
    expect(store.selectedProjectId()).toBe("proj_3");

    expect(await store.removeProject("proj_3")).toBe(true);
    expect(store.projects().map((project) => project.name)).not.toContain("Guest");
    expect(store.selectedProjectId()).toBe(main);
  });

  it("surfaces project path validation errors", async () => {
    const { store } = await setup();

    const added = await store.addProject("relative/folder");
    expect(added).toBeUndefined();
    expect(store.lastActionError()).toContain("must be absolute");
  });

  it("reads a manifest, edits params and validates values", async () => {
    const { store } = await setup();

    const detail = await store.fetchScript(main, redeem, true);
    expect(detail?.manifest.params.map((param) => param.key)).toEqual([
      "rewardTitle",
      "scene",
      "holdSeconds",
    ]);
    expect(detail?.manifest.params.find((param) => param.key === "scene")?.options).toContain(
      "BRB",
    );

    const updated = await store.setScriptParam(main, redeem, "scene", "BRB");
    expect(updated?.summary.generation).toBe(4);
    expect(updated?.manifest.params.find((param) => param.key === "scene")?.value).toBe("BRB");
    expect(store.detail(main, redeem)?.manifest.params[1]?.value).toBe("BRB");

    const invalid = await store.setScriptParam(main, redeem, "scene", 42);
    expect(invalid).toBeUndefined();
    expect(store.lastActionError()).toContain("expects enum");
  });

  it("approves and rejects consent", async () => {
    const { store } = await setup();

    const pending = await store.fetchScript(main, cheer, true);
    expect(pending?.pendingConsent?.diff.added.scopes).toEqual([
      "bits:read",
      "user:write:chat",
    ]);

    const approved = await store.approveConsent("consent-cheer");
    expect(approved?.summary.status).toBe("running");
    expect(approved?.pendingConsent).toBeUndefined();
    expect(store.consents()).toHaveLength(0);
    expect(store.script(main, cheer)?.enabled).toBe(true);

    const detail = await store.fetchScript(main, cheer, true);
    expect(detail?.pendingConsent).toBeUndefined();
  });

  it("applies WatchService changes made by another client", async () => {
    const { runtime, store } = await setup();

    expect(store.script(main, redeem)?.status).toBe("running");
    await runtime.run(runtime.client.StopScript({ projectId: main, scriptId: redeem }));
    await waitFor(
      () => store.script(main, redeem)?.status === "stopped",
      "the stopped script event",
    );
    expect(store.script(main, redeem)?.enabled).toBe(false);
  });

  it("streams logs live for a script", async () => {
    const { store } = await setup();

    await waitFor(() => store.logStatus() === "live", "initial log history");
    const started = await store.startScript(alt, tick);
    expect(started?.summary.status).toBe("running");

    await waitFor(
      () =>
        store
          .logs()
          .some(
            (entry) =>
              entry.scriptId === tick &&
              entry.message.includes("started generation 2"),
          ),
      "the live start log",
    );
  });

  it("keeps enabled tied to explicit start and stop", async () => {
    const { store } = await setup();

    const started = await store.startScript(alt, tick);
    expect(started?.summary.status).toBe("running");
    expect(started?.summary.enabled).toBe(true);

    const stopped = await store.stopScript(alt, tick);
    expect(stopped?.summary.status).toBe("stopped");
    expect(stopped?.summary.enabled).toBe(false);
    expect(store.script(alt, tick)?.enabled).toBe(false);

    const disabled = await store.setScriptEnabled(alt, tick, false);
    expect(disabled?.summary.status).toBe("stopped");
    expect(disabled?.summary.enabled).toBe(false);

    const resumed = await store.setScriptEnabled(alt, tick, true);
    expect(resumed?.summary.status).toBe("running");
    expect(resumed?.summary.enabled).toBe(true);
  });

  it("configures, connects and authorizes connections", async () => {
    const { store } = await setup();

    const configured = await store.configureConnection("obs/secondary", [
      { key: "url", value: "ws://192.168.1.20:4455" },
      { key: "password", value: "hunter2" },
    ]);
    expect(configured?.status).toBe("disconnected");
    expect(configured?.values.find((value) => value.key === "password")).toEqual({
      key: "password",
      isSecret: true,
      isSet: true,
    });

    const connected = await store.connectConnection("obs/secondary");
    expect(connected?.status).toBe("connected");
    expect(store.connection("obs/secondary")?.status).toBe("connected");

    const auth = await store.startConnectionAuth("twitch/bot", "local-app", [
      "user:write:chat",
    ]);
    expect(auth?._tag).toBe("browser");
  });

  it("pairs and unpairs the cloud", async () => {
    const { store } = await setup();

    expect(store.cloud()?.state).toBe("linked");
    const unlinked = await store.unpairCloud();
    expect(unlinked?.state).toBe("unlinked");

    const session = await store.beginCloudPairing("Test PC");
    expect(session?.code).toMatch(/^[A-Z0-9-]+$/);
    await waitFor(() => store.cloud()?.state === "linking", "the linking cloud event");

    const paired = await store.pairCloud(session?.code ?? "", "Test PC");
    expect(paired?.state).toBe("linked");
    expect(paired?.machine?.name).toBe("Test PC");
    expect(store.cloud()?.account?.login).toBe("streamer");
  });

  it("reads a script's source and its content hash", async () => {
    const { store } = await setup();

    const source = await store.fetchScriptSource(main, redeem);
    expect(source?.path).toBe(redeem);
    expect(source?.language).toBe("typescript");
    expect(source?.content).toContain("Effect.gen");
    expect(source?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.scriptSourceRevision(main, redeem)).toBe(0);

    const missing = await store.fetchScriptSource(main, "scripts/nope.ts");
    expect(missing).toBeUndefined();
    expect(store.lastActionError()).toContain("No script");
  });

  it("calls service lifecycle RPCs and refreshes all state", async () => {
    const { store } = await setup();

    expect(await store.restartService("test")).toBe(true);
    expect(await store.shutdownService()).toBe(true);
    expect(await store.refresh()).toBe(true);
    expect(store.health()?.ok).toBe(true);
    expect(store.projects()).toHaveLength(2);
  });
});
