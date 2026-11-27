import { Effect } from "effect";
import { InputAlreadyExistsError, NameConflictError, } from "./errors.js";
import * as Filter from "./Filter.js";
import * as Input from "./Input.js";
import * as SceneItem from "./SceneItem.js";
import { Sceneify } from "./Sceneify.js";
export const sync = (declaration) => Effect.gen(function* () {
    const sceneify = yield* Sceneify;
    return yield* sceneify.sync(declaration);
});
export const declare = (options) => {
    return {
        name: options.name,
        items: options.items,
        filters: options.filters ?? {},
    };
};
//# sourceMappingURL=Scene.js.map