import { Effect } from "effect";
import * as Input from "./Input.js";
import { DeclaredSceneItemRemovalError } from "./errors.js";
import { OBSSocket } from "./OBSSocket.js";
export const Alignment = {
    centerLeft: 1,
    center: 0,
    centerRight: 2,
    topLeft: 5,
    top: 4,
    topRight: 6,
    bottomLeft: 9,
    bottom: 8,
    bottomRight: 10,
};
/**
 * Creates a SceneItem runtime from an ID, scene name, and Input.
 * The OBSSocket is captured at creation and used for all subsequent calls.
 */
export const make = Effect.fnUntraced(function* (id, sceneName, input, declared) {
    const obs = yield* OBSSocket;
    const sceneItem = {
        id,
        sceneName,
        input,
        declared,
        getTransform: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSceneItemTransform", {
                sceneName,
                sceneItemId: id,
            });
            return result.sceneItemTransform;
        }),
        setTransform: (transform) => Effect.gen(function* () {
            yield* obs.call("SetSceneItemTransform", {
                sceneName,
                sceneItemId: id,
                sceneItemTransform: transform,
            });
        }),
        getEnabled: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSceneItemEnabled", {
                sceneName,
                sceneItemId: id,
            });
            return result.sceneItemEnabled;
        }),
        setEnabled: (enabled) => Effect.gen(function* () {
            yield* obs.call("SetSceneItemEnabled", {
                sceneName,
                sceneItemId: id,
                sceneItemEnabled: enabled,
            });
        }),
        getLocked: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSceneItemLocked", {
                sceneName,
                sceneItemId: id,
            });
            return result.sceneItemLocked;
        }),
        setLocked: (locked) => Effect.gen(function* () {
            yield* obs.call("SetSceneItemLocked", {
                sceneName,
                sceneItemId: id,
                sceneItemLocked: locked,
            });
        }),
        getIndex: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSceneItemIndex", {
                sceneName,
                sceneItemId: id,
            });
            return result.sceneItemIndex;
        }),
        setIndex: (index) => Effect.gen(function* () {
            yield* obs.call("SetSceneItemIndex", {
                sceneName,
                sceneItemId: id,
                sceneItemIndex: index,
            });
        }),
        getBlendMode: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSceneItemBlendMode", {
                sceneName,
                sceneItemId: id,
            });
            return result.sceneItemBlendMode;
        }),
        setBlendMode: (blendMode) => Effect.gen(function* () {
            yield* obs.call("SetSceneItemBlendMode", {
                sceneName,
                sceneItemId: id,
                sceneItemBlendMode: blendMode,
            });
        }),
        duplicate: (destinationSceneName) => Effect.gen(function* () {
            const result = yield* obs.call("DuplicateSceneItem", {
                sceneName,
                sceneItemId: id,
                ...(destinationSceneName === undefined
                    ? {}
                    : { destinationSceneName }),
            });
            const destination = destinationSceneName ?? sceneName;
            yield* obs.call("SetSceneItemPrivateSettings", {
                sceneName: destination,
                sceneItemId: result.sceneItemId,
                sceneItemSettings: { SCENEIFY: null },
            });
            return yield* make(result.sceneItemId, destination, input, false).pipe(Effect.provideService(OBSSocket, obs));
        }),
        remove: () => Effect.gen(function* () {
            if (declared) {
                return yield* new DeclaredSceneItemRemovalError({
                    sceneName,
                    sceneItemId: id,
                });
            }
            yield* obs.call("RemoveSceneItem", {
                sceneName,
                sceneItemId: id,
            });
        }),
    };
    return sceneItem;
});
//# sourceMappingURL=SceneItem.js.map