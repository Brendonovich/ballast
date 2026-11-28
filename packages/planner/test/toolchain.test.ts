import { NodePath } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { locateToolchain } from "../src/typecheck.ts";

const service = "C:\\Users\\friend\\AppData\\Local\\Programs\\Ballast\\resources\\service";

const resolveStaged = (specifier: string): string => {
  const modules = service + "\\node_modules";
  switch (specifier) {
    case "@ballast/core":
      return modules + "\\@ballast\\core\\src\\index.ts";
    case "effect/package.json":
      return modules + "\\effect\\package.json";
    default:
      throw new Error("Cannot find module " + specifier);
  }
};

layer(NodePath.layerWin32)("toolchain on Windows", (it) => {
  it.effect("maps @ballast imports into a staged service's node_modules", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const toolchain = locateToolchain(path, resolveStaged);
      expect(toolchain.ballastRoot).toBe(service + "\\node_modules\\@ballast");
      expect(toolchain.modulesRoot).toBe(service + "\\node_modules");
      expect(toolchain.artifactPaths["@ballast/artifact"]).toEqual([
        service + "\\node_modules\\@ballast\\artifact\\src\\index.ts",
      ]);
    }),
  );
});
