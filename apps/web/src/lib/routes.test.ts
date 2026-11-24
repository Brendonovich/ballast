import { describe, expect, it } from "vitest";

import {
  artifactFromPath,
  homeSectionPath,
  projectIdFromPath,
  projectPath,
  projectSectionFromPath,
  projectSectionPath,
} from "./routes.ts";

describe("routes", () => {
  it("keeps the project in project-window section routes", () => {
    const path = projectSectionPath("proj main", "connections");
    expect(path).toBe("/projects/proj%20main/connections");
    expect(projectIdFromPath(path)).toBe("proj main");
    expect(projectSectionFromPath(path)).toBe("connections");
    expect(projectSectionFromPath(projectSectionPath("p", "settings"))).toBe("settings");
    expect(projectSectionFromPath(projectPath("p"))).toBeUndefined();
    expect(projectSectionFromPath("/projects/p/artifacts/connections")).toBeUndefined();
    expect(artifactFromPath("/projects/p/artifacts/dash%20board")).toBe("dash board");
  });

  it("uses the service-wide routes in a plain browser", () => {
    expect(homeSectionPath("settings")).toBe("/settings");
    expect(homeSectionPath("connections", "proj_main")).toBe("/connections?from=proj_main");
  });
});
