import { describe, expect, it } from "vitest";
import type { ProjectDetail, ProjectSummary } from "@ballast/agent-protocol";
import { emptyProjectManifest } from "@ballast/agent-protocol";

import { projectDisplayStatus } from "./project-status.ts";

const summary: ProjectSummary = {
  id: "p",
  name: "P",
  root: "/tmp/p",
  entry: "ballast.ts",
  enabled: true,
  status: "running",
  unitCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  summary,
  manifest: emptyProjectManifest("p", "ballast.ts"),
  requirements: [],
  units: [],
  ...overrides,
});

describe("project display status", () => {
  it("uses the worker status when nothing blocks it", () => {
    expect(projectDisplayStatus(summary, detail(), undefined)).toEqual({
      label: "Running",
      tone: "success",
    });
    expect(projectDisplayStatus({ ...summary, status: "stopped" }, undefined, undefined).label).toBe(
      "Stopped",
    );
  });

  it("puts missing connections ahead of the worker status", () => {
    const blocked = detail({
      requirements: [{ integration: "obs", slot: "main", location: "local" }],
    });
    expect(projectDisplayStatus(summary, blocked, undefined)).toEqual({
      label: "Needs connections",
      tone: "warning",
    });
    const proposed = detail({
      requirements: [
        { integration: "obs", slot: "main", location: "local", proposedInstanceId: "obs/main" },
      ],
    });
    expect(projectDisplayStatus(summary, proposed, undefined).label).toBe("Running");
  });
});
