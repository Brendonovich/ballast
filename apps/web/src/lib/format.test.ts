import { describe, expect, it } from "vitest";
import type { ConnectionSummary, ProjectSummary, UnitSummary } from "@ballast/agent-protocol";

import {
  connectionNeedsAttention,
  connectionStatusLabel,
  paramValueLabel,
  plural,
  projectStatusLabel,
  projectStatusTone,
  projectWorkerRunning,
  unitStatusLabel,
  unitStatusTone,
} from "./format.ts";

const project = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "proj_main",
  name: "Main Channel",
  root: "/Users/streamer/Ballast/main",
  entry: "ballast.ts",
  enabled: false,
  status: "stopped",
  unitCount: 2,
  createdAt: 1_764_000_000_000,
  updatedAt: 1_764_000_000_000,
  ...overrides,
});

const unit = (overrides: Partial<UnitSummary> = {}): UnitSummary => ({
  kind: "run",
  name: "ready",
  status: "waiting",
  ...overrides,
});

const connection = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  id: "obs/main",
  integration: "obs",
  title: "OBS Studio",
  label: "Main OBS",
  location: "local",
  mode: "auto",
  status: "connected",
  fields: [],
  values: [],
  scopes: { granted: [], required: [], missing: [] },
  boundBy: [],
  requiresAuth: false,
  ...overrides,
});

describe("project presentation", () => {
  it("labels stopped, running and consent states", () => {
    expect(projectStatusLabel(project())).toBe("Stopped");
    expect(projectStatusTone(project())).toBe("neutral");
    expect(projectStatusLabel(project({ status: "running", enabled: true }))).toBe("Running");
    expect(projectStatusTone(project({ status: "running", enabled: true }))).toBe("success");
    expect(projectStatusLabel(project({ status: "needs-consent" }))).toBe("Needs consent");
    expect(projectStatusTone(project({ status: "needs-consent" }))).toBe("warning");
  });

  it("distinguishes a failed reload from a stopped project with an error", () => {
    expect(
      projectStatusLabel(
        project({ status: "error", enabled: true, lastError: "ballast.ts:3:1 — nope" }),
      ),
    ).toBe("Running previous version");
    expect(projectStatusLabel(project({ status: "error" }))).toBe("Error");
    expect(projectStatusTone(project({ status: "error" }))).toBe("danger");
    expect(projectWorkerRunning(project({ status: "error", enabled: true }))).toBe(true);
    expect(projectWorkerRunning(project({ status: "error", enabled: false }))).toBe(false);
    expect(projectWorkerRunning(project({ status: "running", enabled: true }))).toBe(true);
    expect(projectWorkerRunning(project({ status: "stopped" }))).toBe(false);
  });
});

describe("unit presentation", () => {
  it("labels unit states", () => {
    expect(unitStatusLabel(unit({ status: "active" }).status)).toBe("Active");
    expect(unitStatusLabel(unit({ status: "waiting" }).status)).toBe("Waiting");
    expect(unitStatusLabel(unit({ status: "error" }).status)).toBe("Error");
    expect(unitStatusTone("active")).toBe("success");
    expect(unitStatusTone("waiting")).toBe("neutral");
    expect(unitStatusTone("error")).toBe("danger");
  });
});

describe("connection presentation", () => {
  it("flags connections that need authorization or report errors", () => {
    expect(connectionNeedsAttention(connection())).toBe(false);
    expect(
      connectionNeedsAttention(
        connection({ status: "reauth-required", scopes: { granted: [], required: ["a"], missing: ["a"] } }),
      ),
    ).toBe(true);
    expect(connectionNeedsAttention(connection({ status: "error" }))).toBe(true);
    expect(connectionStatusLabel("reauth-required")).toBe("Re-auth required");
  });
});

describe("small formatting helpers", () => {
  it("formats param values without losing types", () => {
    expect(paramValueLabel(undefined)).toBe("");
    expect(paramValueLabel("Game")).toBe("Game");
    expect(paramValueLabel(42)).toBe("42");
    expect(paramValueLabel(true)).toBe("On");
    expect(paramValueLabel(false)).toBe("Off");
    expect(paramValueLabel(["Game", "BRB"])).toBe("Game, BRB");
  });

  it("pluralizes counts", () => {
    expect(plural(1, "script")).toBe("1 script");
    expect(plural(2, "script")).toBe("2 scripts");
    expect(plural(0, "project")).toBe("0 projects");
  });
});
