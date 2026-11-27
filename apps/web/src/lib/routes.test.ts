import { describe, expect, it } from "vitest";

import {
  artifactFromPath,
  projectIdFromPath,
  projectSectionFromPath,
  projectSectionPath,
} from "./routes.ts";

describe("routes", () => {
  it("round-trips a project id that needs URL encoding through a section path", () => {
    const path = projectSectionPath("proj main", "connections");
    expect(projectIdFromPath(path)).toBe("proj main");
    expect(projectSectionFromPath(path)).toBe("connections");
  });

  it("does not read an artifact named like a section as a section", () => {
    expect(projectSectionFromPath("/projects/p/artifacts/connections")).toBeUndefined();
    expect(artifactFromPath("/projects/p/artifacts/dash%20board")).toBe("dash board");
  });
});
