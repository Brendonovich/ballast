import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  ensureMcpLauncher,
  isMachineAgentConfig,
  projectAgentSetup,
  writeProjectAgentConfigs,
} from "../src/service/agent-configs.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)));

const ok = async <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> => {
  const exit = await run(effect);
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

const dirs: Array<string> = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ballast-agents-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const launcher = "/data dir/bin/ballast-mcp";

describe("MCP launcher", () => {
  it("writes an executable script that starts this runtime's mcp command with the service dirs", async () => {
    const root = temp();
    const path = await ok(ensureMcpLauncher({ stateDir: join(root, "state"), dataDir: join(root, "data") }));
    expect(path).toBe(join(root, "data", "bin", "ballast-mcp"));
    const script = readFileSync(path, "utf8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`export BALLAST_STATE_DIR='${join(root, "state")}'`);
    expect(script).toContain(`export BALLAST_DATA_DIR='${join(root, "data")}'`);
    expect(script).toContain(`exec '${process.execPath}'`);
    expect(script).toMatch(/ 'mcp' "\$@"\n$/);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    // Idempotent.
    expect(await ok(ensureMcpLauncher({ stateDir: join(root, "state"), dataDir: join(root, "data") }))).toBe(path);
  });
});

describe("project agent configs", () => {
  it("writes each agent's config format", async () => {
    const root = temp();
    const setup = await ok(
      writeProjectAgentConfigs({ projectId: "p", root, launcher, agents: ["opencode", "claude-code", "codex"] }),
    );
    expect(setup.agents.every((agent) => agent.configured)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: { ballast: { type: "local", command: [launcher], timeout: { startup: 30_000 } } } },
    });
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { ballast: { type: "stdio", command: launcher, args: [] } },
    });
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(
      [
        "[mcp_servers.ballast]",
        `command = "${launcher}"`,
        "args = []",
        "startup_timeout_sec = 30",
        "",
      ].join("\n"),
    );
  });

  it("keeps other settings and replaces a stale ballast entry", async () => {
    const root = temp();
    writeFileSync(
      join(root, "opencode.json"),
      JSON.stringify({ model: "x/y", mcp: { servers: { other: { type: "remote", url: "https://e" }, ballast: { type: "local", command: ["/old"] } } } }),
    );
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "o" } } }));
    mkdirSync(join(root, ".codex"));
    writeFileSync(
      join(root, ".codex", "config.toml"),
      [
        'model = "gpt"',
        "",
        "[mcp_servers.ballast]",
        'command = "/old"',
        "",
        "[mcp_servers.ballast.env]",
        'A = "1"',
        "",
        "[mcp_servers.other]",
        'command = "o"',
        "",
      ].join("\n"),
    );
    expect((await ok(projectAgentSetup({ projectId: "p", root, launcher }))).agents.some((agent) => agent.configured)).toBe(false);

    await ok(writeProjectAgentConfigs({ projectId: "p", root, launcher, agents: ["opencode", "claude-code", "codex"] }));
    const opencode = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
    expect(opencode.model).toBe("x/y");
    expect(opencode.mcp.servers.other).toEqual({ type: "remote", url: "https://e" });
    expect(opencode.mcp.servers.ballast.command).toEqual([launcher]);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.other).toEqual({ command: "o" });
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(
      [
        'model = "gpt"',
        "",
        "[mcp_servers.other]",
        'command = "o"',
        "",
        "[mcp_servers.ballast]",
        `command = "${launcher}"`,
        "args = []",
        "startup_timeout_sec = 30",
        "",
      ].join("\n"),
    );
    const setup = await ok(projectAgentSetup({ projectId: "p", root, launcher }));
    expect(setup.agents.every((agent) => agent.configured)).toBe(true);
  });

  it("refuses to rewrite JSON it cannot parse", async () => {
    const root = temp();
    writeFileSync(join(root, "opencode.json"), "{\n  // comment\n}\n");
    const exit = await run(writeProjectAgentConfigs({ projectId: "p", root, launcher, agents: ["opencode"] }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("not plain JSON");
    expect(readFileSync(join(root, "opencode.json"), "utf8")).toBe("{\n  // comment\n}\n");
  });

  it("leaves generated configs out of shares", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(isMachineAgentConfig(".mcp.json", bytes(JSON.stringify({ mcpServers: { ballast: { command: launcher } } })))).toBe(true);
    expect(isMachineAgentConfig("opencode.json", bytes('{"model":"x"}'))).toBe(false);
    expect(isMachineAgentConfig("src/.mcp.json", bytes(launcher))).toBe(false);
  });
});
