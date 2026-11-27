import { describe, expect, it } from "vitest";

import {
  EMPTY_TABS,
  activateTab,
  activeTab,
  closeTab,
  defaultTabs,
  openTab,
  parseTabs,
  pinTab,
  previewTab,
  tabKey,
} from "./project-tabs.ts";

describe("project tabs", () => {
  it("defaults to the entry file", () => {
    const state = defaultTabs("ballast.ts");
    expect(state.tabs).toEqual([{ kind: "file", path: "ballast.ts" }]);
    expect(activeTab(state)).toEqual({ kind: "file", path: "ballast.ts" });
  });

  it("appends new tabs and focuses one that is already open", () => {
    let state = openTab(EMPTY_TABS, { kind: "file", path: "ballast.ts" });
    state = openTab(state, { kind: "artifact", name: "dashboard" });
    state = openTab(state, { kind: "topic", name: "redemption" });
    expect(state.tabs.map(tabKey)).toEqual(["file:ballast.ts", "artifact:dashboard", "topic:redemption"]);
    expect(state.active).toBe("topic:redemption");
    state = openTab(state, { kind: "artifact", name: "dashboard" });
    expect(state.tabs).toHaveLength(3);
    expect(state.active).toBe("artifact:dashboard");
    expect(activateTab(state, "file:ballast.ts").active).toBe("file:ballast.ts");
    expect(activateTab(state, "file:missing.ts")).toBe(state);
  });

  it("closing the active tab focuses its right neighbour, then its left", () => {
    let state = openTab(EMPTY_TABS, { kind: "file", path: "a.ts" });
    state = openTab(state, { kind: "file", path: "b.ts" });
    state = openTab(state, { kind: "file", path: "c.ts" });
    state = activateTab(state, "file:b.ts");
    state = closeTab(state, "file:b.ts");
    expect(state.active).toBe("file:c.ts");
    state = closeTab(state, "file:c.ts");
    expect(state.active).toBe("file:a.ts");
    // Closing an inactive tab keeps the active one.
    state = openTab(state, { kind: "file", path: "d.ts" });
    state = closeTab(state, "file:a.ts");
    expect(state).toEqual({ tabs: [{ kind: "file", path: "d.ts" }], active: "file:d.ts" });
    expect(closeTab(state, "file:d.ts")).toEqual(EMPTY_TABS);
  });

  it("a preview tab is replaced by the next preview until it is pinned", () => {
    let state = defaultTabs("ballast.ts");
    state = previewTab(state, { kind: "artifact", name: "dashboard" });
    expect(state.preview).toBe("artifact:dashboard");
    state = previewTab(state, { kind: "topic", name: "redemption" });
    expect(state.tabs.map(tabKey)).toEqual(["file:ballast.ts", "topic:redemption"]);
    expect(state).toMatchObject({ active: "topic:redemption", preview: "topic:redemption" });

    // Previewing a pinned tab focuses it and leaves the preview alone.
    state = previewTab(state, { kind: "file", path: "ballast.ts" });
    expect(state).toMatchObject({ active: "file:ballast.ts", preview: "topic:redemption" });

    // The preview takes the old preview's place, not the end.
    state = openTab(state, { kind: "file", path: "b.ts" });
    state = previewTab(state, { kind: "file", path: "c.ts" });
    expect(state.tabs.map(tabKey)).toEqual(["file:ballast.ts", "file:c.ts", "file:b.ts"]);

    state = pinTab(state, "file:c.ts");
    expect(state.preview).toBeUndefined();
    expect(pinTab(state, "file:b.ts")).toBe(state);
    state = previewTab(state, { kind: "file", path: "d.ts" });
    expect(state.tabs.map(tabKey)).toEqual(["file:ballast.ts", "file:c.ts", "file:b.ts", "file:d.ts"]);

    // Opening the preview pinned keeps it; closing it clears it.
    expect(openTab(state, { kind: "file", path: "d.ts" }).preview).toBeUndefined();
    expect(closeTab(state, "file:d.ts").preview).toBeUndefined();
    expect(closeTab(state, "file:b.ts").preview).toBe("file:d.ts");
  });

  it("restores a stored state and rejects malformed values", () => {
    const stored = JSON.stringify({
      tabs: [
        { kind: "file", path: "ballast.ts" },
        { kind: "topic", name: "tick" },
        { kind: "topic", name: "tick" },
        { kind: "artifact" },
        { kind: "nope", name: "x" },
      ],
      active: "topic:tick",
      preview: "topic:tick",
    });
    expect(parseTabs(stored)).toEqual({
      tabs: [
        { kind: "file", path: "ballast.ts" },
        { kind: "topic", name: "tick" },
      ],
      active: "topic:tick",
      preview: "topic:tick",
    });
    expect(parseTabs(JSON.stringify({ tabs: [{ kind: "file", path: "a.ts" }], preview: "file:gone" }))?.preview).toBeUndefined();
    expect(parseTabs(JSON.stringify({ tabs: [{ kind: "file", path: "a.ts" }], active: "file:gone" }))?.active).toBe(
      "file:a.ts",
    );
    // Every tab closed is a real state, not "nothing stored".
    expect(parseTabs(JSON.stringify({ tabs: [], active: null }))).toEqual(EMPTY_TABS);
    expect(parseTabs(null)).toBeUndefined();
    expect(parseTabs("{")).toBeUndefined();
    expect(parseTabs("[]")).toBeUndefined();
  });
});
