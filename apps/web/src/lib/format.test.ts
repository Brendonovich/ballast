import { describe, expect, it } from "vitest";
import type { ConnectionSummary, ScriptSummary } from "@ballast/agent-protocol";

import {
  connectionNeedsAttention,
  connectionStatusLabel,
  paramValueLabel,
  plural,
  scriptStatusLabel,
  scriptStatusTone,
} from "./format.ts";

const script = (overrides: Partial<ScriptSummary> = {}): ScriptSummary => ({
  projectId: "proj_main",
  id: "scripts/test.ts",
  name: "Test",
  entry: "scripts/test.ts",
  status: "stopped",
  enabled: false,
  generation: 0,
  updatedAt: 1_764_000_000_000,
  ...overrides,
});

const connection = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  id: "obs/main",
  integration: "obs",
  slot: "main",
  title: "OBS Studio",
  label: "Main OBS",
  location: "local",
  mode: "auto",
  status: "connected",
  fields: [],
  values: [],
  scopes: { granted: [], required: [], missing: [] },
  usedBy: [],
  requiresAuth: false,
  ...overrides,
});

describe("script presentation", () => {
  it("calls a never-started script 'Not started'", () => {
    expect(scriptStatusLabel(script())).toBe("Not started");
    expect(scriptStatusTone(script())).toBe("warning");
  });

  it("labels the states the reduced list shows", () => {
    expect(scriptStatusLabel(script({ status: "running", enabled: true, generation: 2 }))).toBe(
      "Running",
    );
    expect(scriptStatusLabel(script({ status: "needs-consent" }))).toBe("Needs consent");
    expect(scriptStatusTone(script({ status: "error" }))).toBe("danger");
    expect(scriptStatusLabel(script({ status: "stopped", generation: 3 }))).toBe("Stopped");
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
  });

  it("pluralizes counts", () => {
    expect(plural(1, "script")).toBe("1 script");
    expect(plural(2, "script")).toBe("2 scripts");
    expect(plural(0, "project")).toBe("0 projects");
  });
});
