import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_MODE,
  parseProjectMode,
  projectModeStorageKey,
} from "./project-mode.ts";

describe("project mode", () => {
  it("defaults to Develop and only restores an explicit View", () => {
    expect(parseProjectMode(null)).toBe(DEFAULT_PROJECT_MODE);
    expect(DEFAULT_PROJECT_MODE).toBe("develop");
    expect(parseProjectMode("view")).toBe("view");
    expect(parseProjectMode("develop")).toBe("develop");
    expect(parseProjectMode("")).toBe("develop");
    expect(parseProjectMode("VIEW")).toBe("develop");
  });

  it("is stored per project", () => {
    expect(projectModeStorageKey("a")).toBe("ballast.projectMode.a");
    expect(projectModeStorageKey("a")).not.toBe(projectModeStorageKey("b"));
  });
});
