import { describe, expect, it } from "vitest";

import { DEFAULT_SIDEBAR, isSidebarShortcut, parseSidebarLayout } from "./sidebar-layout.ts";

const key = (overrides: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>) => ({
  key: "b",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("sidebar layout", () => {
  it("opens both sections by default and restores a stored layout", () => {
    expect(parseSidebarLayout(null)).toEqual(DEFAULT_SIDEBAR);
    expect(parseSidebarLayout("nope")).toEqual(DEFAULT_SIDEBAR);
    expect(parseSidebarLayout(JSON.stringify({ filesOpen: false, outlineOpen: true, split: 0.6 }))).toEqual({
      filesOpen: false,
      outlineOpen: true,
      split: 0.6,
    });
    expect(parseSidebarLayout(JSON.stringify({ split: 4 })).split).toBe(0.85);
    expect(parseSidebarLayout(JSON.stringify({ split: -1, filesOpen: "yes" }))).toEqual({
      ...DEFAULT_SIDEBAR,
      split: 0.15,
    });
  });

  it("toggles with ⌘B on macOS and Ctrl+B elsewhere", () => {
    expect(isSidebarShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSidebarShortcut(key({ key: "B", metaKey: true }), true)).toBe(true);
    expect(isSidebarShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSidebarShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isSidebarShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(key({ key: "n", metaKey: true }), true)).toBe(false);
  });
});
