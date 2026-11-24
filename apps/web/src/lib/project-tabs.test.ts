import { describe, expect, it } from "vitest";

import {
  EMPTY_TABS,
  activateTab,
  activeTab,
  closeTab,
  defaultTabs,
  openTab,
  parseTabs,
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
    });
    expect(parseTabs(stored)).toEqual({
      tabs: [
        { kind: "file", path: "ballast.ts" },
        { kind: "topic", name: "tick" },
      ],
      active: "topic:tick",
    });
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
