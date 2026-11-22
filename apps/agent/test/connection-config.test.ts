import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_OBS_URL,
  parseAssignment,
  resolveObsConnectionConfig,
} from "../src/connection-config.ts";

const none = { connections: new Map<string, string>(), secrets: new Map<string, string>() };

describe("OBS connection config", () => {
  it("defaults to the local obs-websocket url with no password", () => {
    expect(resolveObsConnectionConfig("main", none, {})).toEqual({
      slot: "main",
      url: DEFAULT_OBS_URL,
    });
  });

  it("reads the url from --connection and the secret from --connection-secret", () => {
    expect(
      resolveObsConnectionConfig(
        "main",
        {
          connections: new Map([["obs/main", "ws://192.168.1.2:4455"]]),
          secrets: new Map([["obs/main", "cli-secret"]]),
        },
        { BALLAST_OBS_MAIN_PASSWORD: "env-secret" },
      ),
    ).toEqual({
      slot: "main",
      url: "ws://192.168.1.2:4455",
      password: "cli-secret",
    });
  });

  it("falls back to BALLAST_OBS_<SLOT>_PASSWORD", () => {
    expect(
      resolveObsConnectionConfig("stream-pc", none, {
        BALLAST_OBS_STREAM_PC_PASSWORD: "env-secret",
      }),
    ).toEqual({
      slot: "stream-pc",
      url: DEFAULT_OBS_URL,
      password: "env-secret",
    });
  });

  it("rejects credential-bearing urls", () => {
    expect(() =>
      resolveObsConnectionConfig(
        "main",
        { connections: new Map([["obs/main", "ws://user:pass@127.0.0.1:4455"]]), secrets: new Map() },
        {},
      ),
    ).toThrow("must not contain credentials");
  });

  it("parses key=value assignments", () => {
    expect(parseAssignment("obs/main=ws://127.0.0.1:4455", "--connection")).toEqual({
      key: "obs/main",
      value: "ws://127.0.0.1:4455",
    });
    expect(() => parseAssignment("missing-equals", "--connection")).toThrow(
      "expected key=value",
    );
  });
});
