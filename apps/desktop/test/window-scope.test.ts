import { describe, expect, it } from "vitest";

import { devWindowUrl, planRescope } from "../src/main/window-scope.ts";

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

describe("dev window URL", () => {
  it("connects the Vite UI to the live service and preserves the route", () => {
    const target = new URL(
      devWindowUrl(
        "http://127.0.0.1:5173/",
        { url: "http://127.0.0.1:51234", token: "token&secret" },
        "#/projects/project%20one",
      ),
    );
    expect(target.origin).toBe("http://127.0.0.1:5173");
    expect(target.searchParams.get("service")).toBe("http://127.0.0.1:51234");
    expect(target.searchParams.get("token")).toBe("token&secret");
    expect(target.hash).toBe("#/projects/project%20one");
  });
});
