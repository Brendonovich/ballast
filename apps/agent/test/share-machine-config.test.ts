import { describe, expect, it } from "vitest";
import { isMachineConfig } from "../src/service/shares.ts";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe("share machine configs", () => {
  it("leaves out an unmarked tsconfig that points at absolute type paths", () => {
    const legacy = encode({
      compilerOptions: {
        paths: { "@ballast/*": ["/Users/someone/.local/share/ballast/types/current/@ballast/*/src/index.ts"] },
        typeRoots: ["/Users/someone/.local/share/ballast/types/current/@types"],
      },
    });
    const windows = encode({
      compilerOptions: { typeRoots: ["C:\\Users\\someone\\AppData\\Roaming\\ballast\\types\\current\\@types"] },
    });
    const portable = encode({ compilerOptions: { paths: { "~/*": ["./src/*"] } } });
    expect(isMachineConfig("tsconfig.json", legacy)).toBe(true);
    expect(isMachineConfig("artifacts/tsconfig.json", windows)).toBe(true);
    expect(isMachineConfig("tsconfig.json", portable)).toBe(false);
  });
});
