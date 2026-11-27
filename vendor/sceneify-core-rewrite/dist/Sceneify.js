import { Context, Effect, Layer, HashMap, Ref, Option } from "effect";
import { OBSSocket } from "./OBSSocket.js";
import { makeSceneSync } from "./SceneSync.js";
/**
 * Sceneify service tag
 */
export const Sceneify = Context.Service("@sceneify/Sceneify");
/**
 * Create a Sceneify service for the OBSSocket in context
 */
export const make = Effect.gen(function* () {
    // Create a Ref to hold the map of instantiated inputs
    const inputsRef = yield* Ref.make(HashMap.empty());
    const obs = yield* OBSSocket;
    const registerInput = (input) => Ref.update(inputsRef, (inputs) => HashMap.set(inputs, input.name, input));
    const sceneSync = yield* makeSceneSync({ registerInput }, obs);
    // Create the service implementation
    const service = {
        getInput: (name) => Ref.get(inputsRef).pipe(Effect.map((inputs) => Option.getOrUndefined(HashMap.get(inputs, name)))),
        registerInput,
        hasInput: (name) => Ref.get(inputsRef).pipe(Effect.map((inputs) => HashMap.has(inputs, name))),
        clear: () => Ref.set(inputsRef, HashMap.empty()).pipe(Effect.andThen(sceneSync.clear)),
        sync: sceneSync.sync,
    };
    return service;
});
/**
 * Create a Sceneify layer
 */
export const layer = Layer.effect(Sceneify, make);
//# sourceMappingURL=Sceneify.js.map