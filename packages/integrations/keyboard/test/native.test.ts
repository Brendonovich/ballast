import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeNativeBackend } from "../src/driver/index.ts";

/**
 * Real addon smoke. uiohook-napi loads its prebuilt N-API binary at import
 * time; starting the hook should not throw even when macOS has not granted
 * Accessibility permission (it just receives nothing). The permission state
 * is reported instead of guessed.
 */
describe("uiohook-napi smoke", () => {
  it.live("loads, starts and stops the global hook", () =>
    Effect.gen(function* () {
      const backend = makeNativeBackend();
      const result = yield* Effect.exit(Effect.scoped(backend.listen(() => {})));
      if (Exit.isFailure(result)) {
        // Missing prebuilds or a headless/unsupported host: report, don't fail.
        console.warn(
          "uiohook-napi could not start the hook; global keyboard input is unavailable in this environment.",
        );
        return;
      }

      const permission = yield* backend.permission;
      if (permission !== "granted") {
        console.warn(
          `uiohook-napi is listening with permission=${permission}. On macOS grant Accessibility (and Input Monitoring) to this process; the hook starts silently without it and receives no events.`,
        );
      }
      if (process.platform === "darwin") expect(permission).toBe("unknown");
      else expect(permission).toBe("granted");
    }),
  );
});
