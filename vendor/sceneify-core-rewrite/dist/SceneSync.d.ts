import { Effect } from "effect";
import { InvalidDeclarationError, NameConflictError } from "./errors.ts";
import type { FilterType } from "./FilterType.ts";
import * as Input from "./Input.ts";
import type { InputType } from "./InputType.ts";
import { OBSSocket } from "./OBSSocket.ts";
import type * as Scene from "./Scene.ts";
interface SceneSyncRegistry {
    readonly registerInput: (input: {
        readonly name: string;
    }) => Effect.Effect<void>;
}
export declare const makeSceneSync: (registry: SceneSyncRegistry, obs: OBSSocket) => Effect.Effect<{
    sync: <TItems extends Record<string, Input.Declaration<InputType<string, any>, {}>>, TFilters extends Record<string, FilterType<string, any>>>(declaration: Scene.SceneDeclaration<TItems, TFilters>) => Effect.Effect<Scene.Scene<TItems, TFilters>, InvalidDeclarationError | NameConflictError | import("./errors.ts").OBSError, never>;
    clear: Effect.Effect<void, never, never>;
}, never, never>;
export {};
//# sourceMappingURL=SceneSync.d.ts.map