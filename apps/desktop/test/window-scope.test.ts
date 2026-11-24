import { describe, expect, it } from "vitest";

import { planRescope, titleBarOptions } from "../src/main/window-scope.ts";

const windows = [
  { id: 1, kind: "project" as const, projectId: "a" },
  { id: 2, kind: "project" as const, projectId: "b" },
  { id: 3, kind: "home" as const },
  { id: 4, kind: "artifact" as const, projectId: "a" },
];

describe("project re-scope", () => {
  it("re-scopes a window to a project no other window shows", () => {
    expect(planRescope(windows, 1, "c")).toEqual({ action: "rescope" });
    expect(planRescope(windows, 3, "c")).toEqual({ action: "rescope" });
  });

  it("focuses the window that already shows the project", () => {
    expect(planRescope(windows, 1, "b")).toEqual({ action: "focus", id: 2 });
    expect(planRescope(windows, 3, "a")).toEqual({ action: "focus", id: 1 });
  });

  it("leaves a window alone when it already shows the project", () => {
    expect(planRescope(windows, 2, "b")).toEqual({ action: "unchanged" });
  });

  it("refuses artifact and unknown windows", () => {
    expect(planRescope(windows, 4, "b").action).toBe("reject");
    expect(planRescope(windows, 99, "b").action).toBe("reject");
  });
});

describe("title bar", () => {
  it("insets the traffic lights into the web bar on macOS only", () => {
    expect(titleBarOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 13 },
    });
    expect(titleBarOptions("win32")).toEqual({});
    expect(titleBarOptions("linux")).toEqual({});
  });
});
