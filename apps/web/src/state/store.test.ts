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
  it("loads the snapshot and project list", async () => {
    const { store } = await setup();

    expect(store.watchStatus()).toBe("live");
    expect(store.info()?.name).toBe("ballast-agent");
    expect(store.info()?.apiVersion).toBe(1);
    expect(store.projects().map((project) => project.name)).toEqual([
      "Main Channel",
      "Second Channel",
    ]);
    expect(store.project(main)?.status).toBe("running");
    expect(store.health()?.projects.total).toBe(2);
  });

  it("loads the integration catalog", async () => {
    const { store } = await setup();

    await store.loadIntegrations();
    const obs = store.integrations().find((entry) => entry.integration === "obs");
    expect(obs?.title).toBe("OBS Studio");
    expect(obs?.modes).toEqual(["local-app"]);
    expect(obs?.fields.some((field) => field.key === "url")).toBe(true);
    expect(store.integrations().some((entry) => entry.integration === "twitch")).toBe(true);
  });

  it("loads the cloud accounts available through the linked cloud", async () => {
    const { store } = await setup();

    await store.loadCloudAccounts();
    expect(store.cloudAccounts().map((account) => account.login)).toEqual([
      "streamer",
      "streamer_bot",
    ]);
    expect(store.cloudAccounts().find((account) => account.login === "streamer_bot")?.needsReauth).toBe(
      true,
    );
  });

  it("creates, adds and removes projects", async () => {
    const { store } = await setup();

    const created = await store.createProject("Guest Channel", "/Users/streamer/Ballast/guest");
    expect(created?.summary.status).toBe("stopped");
    expect(created?.summary.unitCount).toBe(0);
    expect(store.project(created?.summary.id ?? "")?.name).toBe("Guest Channel");

    const added = await store.addProject("/Users/streamer/Ballast/other", "Other");
    expect(added?.summary.id).toBe("proj_4");
    expect(store.projects().map((project) => project.name)).toContain("Other");

    expect(await store.removeProject(added?.summary.id ?? "")).toBe(true);
    expect(store.projects().map((project) => project.name)).not.toContain("Other");
  });

  it("surfaces project path validation errors", async () => {
    const { store } = await setup();

    const added = await store.addProject("relative/folder");
    expect(added).toBeUndefined();
    expect(store.lastActionError()).toContain("must be absolute");
  });

  it("loads project detail, units and starts/stops the worker", async () => {
    const { store } = await setup();

    const detail = await store.fetchProject(main, true);
    expect(detail?.summary.id).toBe(main);
    expect(detail?.units.length).toBeGreaterThan(0);
    expect(store.projectDetail(main)?.units.length).toBe(detail?.units.length);

    const stopped = await store.stopProject(main);
    expect(stopped?.summary.status).toBe("stopped");
    expect(store.project(main)?.status).toBe("stopped");

    const started = await store.startProject(main);
    expect(started?.summary.status).toBe("running");
    expect(store.project(main)?.status).toBe("running");
  });

  it("mints and renews an artifact view", async () => {
    const { store } = await setup();

    const artifacts = await store.fetchArtifacts(main, true);
    expect(artifacts?.some((artifact) => artifact.name === "dashboard")).toBe(true);
    const view = await store.getArtifactView(main, "dashboard");
    expect(view?.scope).toBe("action");
    if (view === undefined) return;

    const renewed = await store.renewArtifactView(view.token);
    expect(renewed).toBeDefined();
    if (renewed === undefined) return;
    expect(renewed.token).toBe(view.token);
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(view.expiresAt);
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

  it("lists and reads project files", async () => {
    const { store } = await setup();

    const tree = await store.listProjectFiles(main);
    expect(tree?.entry).toBe("ballast.ts");
    expect(tree?.files.some((file) => file.path === "ballast.ts")).toBe(true);

    const file = await store.readProjectFile(main, "ballast.ts");
    expect(file?.path).toBe("ballast.ts");
    expect(file?.language).toBe("typescript");
    expect(file?.content).toContain("mock source");
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/);

  });

  it("creates, updates and deletes connection instances", async () => {
    const { store } = await setup();

    const created = await store.createConnection({
      integration: "fake",
      label: "New Fake",
      config: { prefix: ">>" },
    });
    expect(created?.label).toBe("New Fake");
    expect(store.connections().some((connection) => connection.id === created?.id)).toBe(true);

    const updated = await store.updateConnection({
      id: created?.id ?? "",
      label: "Renamed Fake",
    });
    expect(updated?.label).toBe("Renamed Fake");
    expect(store.connection(created?.id ?? "")?.label).toBe("Renamed Fake");

    expect(await store.deleteConnection(created?.id ?? "")).toBe(true);
    expect(store.connection(created?.id ?? "")).toBeUndefined();
  });

  it("binds requirements and refuses deleting a bound instance", async () => {
    const { store } = await setup();
    const instance = await store.createConnection({
      integration: "obs",
      label: "Test OBS",
      config: { url: "ws://127.0.0.1:4455" },
    });
    if (instance === undefined) throw new Error("Expected a created OBS instance");

    const bound = await store.setProjectBinding(main, "obs", "main", instance.id);
    expect(
      bound?.requirements.find(
        (requirement) => requirement.integration === "obs" && requirement.slot === "main",
      )?.boundInstanceId,
    ).toBe(instance.id);
    expect(
      store.connection(instance.id)?.boundBy.some((ref) => ref.projectId === main),
    ).toBe(true);

    expect(await store.deleteConnection(instance.id)).toBe(false);
    expect(store.lastActionError()).toContain("unbind");

    const unbound = await store.setProjectBinding(main, "obs", "main", null);
    expect(
      unbound?.requirements.find(
        (requirement) => requirement.integration === "obs" && requirement.slot === "main",
      )?.boundInstanceId,
    ).toBeUndefined();
    expect(await store.deleteConnection(instance.id)).toBe(true);
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

  it("reports a shell permission to the service", async () => {
    const { store } = await setup();
    expect(await store.reportShellPermission("accessibility", "denied")).toBe(true);
  });

  it("calls service lifecycle RPCs and refreshes all state", async () => {
    const { store } = await setup();

    expect(await store.shutdownService()).toBe(true);
    expect(await store.refresh()).toBe(true);
    expect(store.health()?.ok).toBe(true);
    expect(store.projects()).toHaveLength(2);
  });
});
