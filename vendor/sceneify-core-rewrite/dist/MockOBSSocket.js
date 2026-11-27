import { Effect, Layer } from "effect";
import { OBSError } from "./errors.js";
import { OBSCallTypeId, OBSSocket, collectBatchResponses, makeCall, } from "./OBSSocket.js";
class RequestError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const deepFreeze = (value, seen = new WeakSet()) => {
    if (typeof value !== "object" || value === null || seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        deepFreeze(Reflect.get(value, key), seen);
    }
    return Object.freeze(value);
};
// Request data is copied and frozen once at the boundary. State, responses,
// and snapshots can then safely share readonly values without output cloning.
const copyIn = (value) => deepFreeze(structuredClone(value));
const reindex = (values) => values.map((value, index) => value.index === index ? value : { ...value, index });
const filterFromSeed = (seed, index) => ({
    name: seed.name,
    kind: seed.kind,
    settings: copyIn(seed.settings ?? {}),
    enabled: seed.enabled ?? true,
    index,
});
const defaultTransform = (input) => {
    const sourceWidth = Number(input?.settings.width ?? 0);
    const sourceHeight = Number(input?.settings.height ?? 0);
    return {
        alignment: 5,
        boundsAlignment: 0,
        boundsHeight: 0,
        boundsType: "OBS_BOUNDS_NONE",
        boundsWidth: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
        cropToBounds: false,
        cropTop: 0,
        positionX: 0,
        positionY: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        sourceHeight,
        sourceWidth,
        height: sourceHeight,
        width: sourceWidth,
    };
};
const findInput = (state, name) => state.inputs.find((value) => value.name === name);
const findScene = (state, name) => state.scenes.find((value) => value.name === name);
const requireInput = (state, name) => {
    const value = findInput(state, name);
    if (!value) {
        throw new RequestError(600, `No source was found by the name of \`${name}\`.`);
    }
    return value;
};
const requireScene = (state, name) => {
    const value = findScene(state, name);
    if (!value) {
        throw new RequestError(600, `No source was found by the name of \`${name}\`.`);
    }
    return value;
};
const requireSource = (state, name) => {
    const value = findInput(state, name) ?? findScene(state, name);
    if (!value) {
        throw new RequestError(600, `No source was found by the name of \`${name}\`.`);
    }
    return value;
};
const requireSceneItem = (state, sceneName, id) => {
    const value = requireScene(state, sceneName).items.find((item) => item.id === id);
    if (!value) {
        throw new RequestError(600, `No scene item was found with the numeric ID \`${id}\` in the scene \`${sceneName}\`.`);
    }
    return value;
};
const requireFilter = (state, sourceName, filterName) => {
    const value = requireSource(state, sourceName).filters.find((candidate) => candidate.name === filterName);
    if (!value) {
        throw new RequestError(600, `No filter was found in the source \`${sourceName}\` with the name \`${filterName}\`.`);
    }
    return value;
};
const updateInput = (state, name, update) => {
    requireInput(state, name);
    return {
        ...state,
        inputs: state.inputs.map((value) => value.name === name ? update(value) : value),
    };
};
const updateScene = (state, name, update) => {
    requireScene(state, name);
    return {
        ...state,
        scenes: state.scenes.map((value) => value.name === name ? update(value) : value),
    };
};
const updateSource = (state, name, update) => {
    if (findInput(state, name)) {
        return updateInput(state, name, (value) => ({
            ...value,
            ...update(value),
        }));
    }
    return updateScene(state, name, (value) => ({ ...value, ...update(value) }));
};
const updateSceneItem = (state, sceneName, id, update) => {
    requireSceneItem(state, sceneName, id);
    return updateScene(state, sceneName, (value) => ({
        ...value,
        items: value.items.map((item) => (item.id === id ? update(item) : item)),
    }));
};
const renderedTransform = (state, item) => {
    const input = findInput(state, item.sourceName);
    const sourceWidth = Number(input?.settings.width ?? 0);
    const sourceHeight = Number(input?.settings.height ?? 0);
    return {
        ...item.transform,
        sourceWidth,
        sourceHeight,
        width: sourceWidth * Number(item.transform.scaleX ?? 1),
        height: sourceHeight * Number(item.transform.scaleY ?? 1),
    };
};
const filterResponse = (value) => ({
    filterEnabled: value.enabled,
    filterIndex: value.index,
    filterKind: value.kind,
    filterSettings: value.settings,
});
const unchanged = (state, response) => ({
    state,
    response,
});
const changed = (state, response) => ({
    state,
    response,
});
const reduceRequest = (state, requestType, data = {}) => {
    switch (requestType) {
        case "GetInputList":
            return unchanged(state, {
                inputs: state.inputs.map((value) => ({
                    inputKind: value.kind,
                    inputName: value.name,
                    inputUuid: value.uuid,
                    unversionedInputKind: value.kind,
                })),
            });
        case "GetSceneList":
            return unchanged(state, {
                currentPreviewSceneName: state.currentPreviewSceneName,
                currentPreviewSceneUuid: state.currentPreviewSceneName
                    ? requireScene(state, state.currentPreviewSceneName).uuid
                    : null,
                currentProgramSceneName: state.currentProgramSceneName,
                currentProgramSceneUuid: state.currentProgramSceneName
                    ? requireScene(state, state.currentProgramSceneName).uuid
                    : null,
                scenes: state.scenes.map((value) => ({
                    sceneIndex: state.scenes.indexOf(value),
                    sceneName: value.name,
                    sceneUuid: value.uuid,
                })),
            });
        case "CreateScene": {
            if (findInput(state, data.sceneName) ||
                findScene(state, data.sceneName)) {
                throw new RequestError(601, "A source already exists by that scene name.");
            }
            const created = {
                name: data.sceneName,
                uuid: `mock-scene-${state.nextUuid}`,
                privateSettings: {},
                filters: [],
                items: [],
                transitionName: null,
                transitionDuration: null,
            };
            return changed({
                ...state,
                scenes: [...state.scenes, created],
                currentProgramSceneName: state.currentProgramSceneName ?? created.name,
                nextUuid: state.nextUuid + 1,
            }, { sceneUuid: created.uuid });
        }
        case "RemoveScene": {
            requireScene(state, data.sceneName);
            const scenes = state.scenes.filter((value) => value.name !== data.sceneName);
            return changed({
                ...state,
                scenes,
                currentProgramSceneName: state.currentProgramSceneName === data.sceneName
                    ? scenes[0]?.name ?? null
                    : state.currentProgramSceneName,
                currentPreviewSceneName: state.currentPreviewSceneName === data.sceneName
                    ? null
                    : state.currentPreviewSceneName,
            });
        }
        case "GetSceneItemList": {
            const target = requireScene(state, data.sceneName);
            return unchanged(state, {
                sceneItems: target.items.map((item) => {
                    const input = findInput(state, item.sourceName);
                    const nestedScene = findScene(state, item.sourceName);
                    return {
                        inputKind: input?.kind ?? null,
                        isGroup: null,
                        sceneItemBlendMode: item.blendMode,
                        sceneItemEnabled: item.enabled,
                        sceneItemId: item.id,
                        sceneItemIndex: item.index,
                        sceneItemLocked: item.locked,
                        sceneItemTransform: renderedTransform(state, item),
                        sourceName: item.sourceName,
                        sourceType: input
                            ? "OBS_SOURCE_TYPE_INPUT"
                            : "OBS_SOURCE_TYPE_SCENE",
                        sourceUuid: input?.uuid ?? nestedScene?.uuid,
                    };
                }),
            });
        }
        case "CreateInput": {
            requireScene(state, data.sceneName);
            if (findInput(state, data.inputName) ||
                findScene(state, data.inputName)) {
                throw new RequestError(601, "A source already exists by that input name.");
            }
            const created = {
                name: data.inputName,
                uuid: `mock-input-${state.nextUuid}`,
                kind: data.inputKind,
                settings: copyIn(data.inputSettings ?? {}),
                privateSettings: {},
                filters: [],
                muted: false,
                volumeMul: 1,
                audioBalance: 0.5,
                audioSyncOffset: 0,
                audioMonitorType: "OBS_MONITORING_TYPE_NONE",
                audioTracks: {},
                propertyLists: {},
            };
            const item = {
                id: state.nextSceneItemId,
                sourceName: created.name,
                enabled: data.sceneItemEnabled ?? true,
                locked: false,
                transform: defaultTransform(created),
                blendMode: "OBS_BLEND_NORMAL",
                privateSettings: {},
                index: requireScene(state, data.sceneName).items.length,
            };
            const next = updateScene({ ...state, inputs: [...state.inputs, created] }, data.sceneName, (value) => ({ ...value, items: [...value.items, item] }));
            return changed({
                ...next,
                nextUuid: state.nextUuid + 1,
                nextSceneItemId: state.nextSceneItemId + 1,
            }, { inputUuid: created.uuid, sceneItemId: item.id });
        }
        case "RemoveInput": {
            requireInput(state, data.inputName);
            return changed({
                ...state,
                inputs: state.inputs.filter((value) => value.name !== data.inputName),
                scenes: state.scenes.map((value) => {
                    if (!value.items.some((item) => item.sourceName === data.inputName)) {
                        return value;
                    }
                    return {
                        ...value,
                        items: reindex(value.items.filter((item) => item.sourceName !== data.inputName)),
                    };
                }),
            });
        }
        case "CreateSceneItem": {
            requireSource(state, data.sourceName);
            const target = requireScene(state, data.sceneName);
            const item = {
                id: state.nextSceneItemId,
                sourceName: data.sourceName,
                enabled: data.sceneItemEnabled ?? true,
                locked: false,
                transform: defaultTransform(findInput(state, data.sourceName)),
                blendMode: "OBS_BLEND_NORMAL",
                privateSettings: {},
                index: target.items.length,
            };
            return changed({
                ...updateScene(state, data.sceneName, (value) => ({
                    ...value,
                    items: [...value.items, item],
                })),
                nextSceneItemId: state.nextSceneItemId + 1,
            }, { sceneItemId: item.id });
        }
        case "RemoveSceneItem": {
            requireSceneItem(state, data.sceneName, data.sceneItemId);
            return changed(updateScene(state, data.sceneName, (value) => ({
                ...value,
                items: reindex(value.items.filter((item) => item.id !== data.sceneItemId)),
            })));
        }
        case "DuplicateSceneItem": {
            const item = requireSceneItem(state, data.sceneName, data.sceneItemId);
            const destinationSceneName = data.destinationSceneName ?? data.sceneName;
            const destination = requireScene(state, destinationSceneName);
            const duplicate = {
                ...item,
                id: state.nextSceneItemId,
                transform: copyIn(item.transform),
                privateSettings: copyIn(item.privateSettings),
                index: destination.items.length,
            };
            return changed({
                ...updateScene(state, destinationSceneName, (scene) => ({
                    ...scene,
                    items: [...scene.items, duplicate],
                })),
                nextSceneItemId: state.nextSceneItemId + 1,
            }, { sceneItemId: duplicate.id });
        }
        case "GetSceneItemTransform":
            return unchanged(state, {
                sceneItemTransform: renderedTransform(state, requireSceneItem(state, data.sceneName, data.sceneItemId)),
            });
        case "SetSceneItemTransform":
            return changed(updateSceneItem(state, data.sceneName, data.sceneItemId, (item) => ({
                ...item,
                transform: {
                    ...item.transform,
                    ...copyIn(data.sceneItemTransform),
                },
            })));
        case "GetSceneItemEnabled":
            return unchanged(state, {
                sceneItemEnabled: requireSceneItem(state, data.sceneName, data.sceneItemId).enabled,
            });
        case "SetSceneItemEnabled":
            return changed(updateSceneItem(state, data.sceneName, data.sceneItemId, (item) => ({
                ...item,
                enabled: data.sceneItemEnabled,
            })));
        case "GetSceneItemLocked":
            return unchanged(state, {
                sceneItemLocked: requireSceneItem(state, data.sceneName, data.sceneItemId).locked,
            });
        case "SetSceneItemLocked":
            return changed(updateSceneItem(state, data.sceneName, data.sceneItemId, (item) => ({
                ...item,
                locked: data.sceneItemLocked,
            })));
        case "GetSceneItemIndex":
            return unchanged(state, {
                sceneItemIndex: requireSceneItem(state, data.sceneName, data.sceneItemId).index,
            });
        case "SetSceneItemIndex": {
            const target = requireScene(state, data.sceneName);
            const item = requireSceneItem(state, data.sceneName, data.sceneItemId);
            const without = target.items.filter((value) => value.id !== item.id);
            const index = Math.max(0, Math.min(data.sceneItemIndex, without.length));
            return changed(updateScene(state, data.sceneName, (value) => ({
                ...value,
                items: reindex([
                    ...without.slice(0, index),
                    item,
                    ...without.slice(index),
                ]),
            })));
        }
        case "GetSceneItemBlendMode":
            return unchanged(state, {
                sceneItemBlendMode: requireSceneItem(state, data.sceneName, data.sceneItemId).blendMode,
            });
        case "SetSceneItemBlendMode":
            return changed(updateSceneItem(state, data.sceneName, data.sceneItemId, (item) => ({
                ...item,
                blendMode: data.sceneItemBlendMode,
            })));
        case "GetInputSettings": {
            const value = requireInput(state, data.inputName);
            return unchanged(state, {
                inputKind: value.kind,
                inputSettings: value.settings,
            });
        }
        case "SetInputSettings":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                settings: data.overlay === false
                    ? copyIn(data.inputSettings)
                    : { ...value.settings, ...copyIn(data.inputSettings) },
            })));
        case "GetInputMute":
            return unchanged(state, {
                inputMuted: requireInput(state, data.inputName).muted,
            });
        case "SetInputMute":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                muted: data.inputMuted,
            })));
        case "ToggleInputMute": {
            const muted = !requireInput(state, data.inputName).muted;
            return changed(updateInput(state, data.inputName, (value) => ({ ...value, muted })), { inputMuted: muted });
        }
        case "GetInputVolume": {
            const mul = requireInput(state, data.inputName).volumeMul;
            return unchanged(state, {
                inputVolumeDb: mul === 0 ? -100 : 20 * Math.log10(mul),
                inputVolumeMul: mul,
            });
        }
        case "SetInputVolume":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                volumeMul: data.inputVolumeMul ?? Math.pow(10, data.inputVolumeDb / 20),
            })));
        case "GetInputAudioBalance":
            return unchanged(state, {
                inputAudioBalance: requireInput(state, data.inputName).audioBalance,
            });
        case "SetInputAudioBalance":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                audioBalance: data.inputAudioBalance,
            })));
        case "GetInputAudioSyncOffset":
            return unchanged(state, {
                inputAudioSyncOffset: requireInput(state, data.inputName)
                    .audioSyncOffset,
            });
        case "SetInputAudioSyncOffset":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                audioSyncOffset: data.inputAudioSyncOffset,
            })));
        case "GetInputAudioMonitorType":
            return unchanged(state, {
                monitorType: requireInput(state, data.inputName).audioMonitorType,
            });
        case "SetInputAudioMonitorType":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                audioMonitorType: data.monitorType,
            })));
        case "GetInputAudioTracks":
            return unchanged(state, {
                inputAudioTracks: requireInput(state, data.inputName).audioTracks,
            });
        case "SetInputAudioTracks":
            return changed(updateInput(state, data.inputName, (value) => ({
                ...value,
                audioTracks: copyIn(data.inputAudioTracks),
            })));
        case "GetInputPropertiesListPropertyItems": {
            const items = requireInput(state, data.inputName).propertyLists[data.propertyName] ??
                [];
            return unchanged(state, {
                propertyItems: items.map((item) => ({
                    itemEnabled: item.enabled ?? true,
                    itemName: item.name,
                    ...(item.value === undefined ? {} : { itemValue: item.value }),
                })),
            });
        }
        case "PressInputPropertiesButton":
            requireInput(state, data.inputName);
            return unchanged(state);
        case "GetSourcePrivateSettings":
            return unchanged(state, {
                sourceSettings: requireSource(state, data.sourceName).privateSettings,
            });
        case "SetSourcePrivateSettings":
            return changed(updateSource(state, data.sourceName, (value) => ({
                ...value,
                privateSettings: {
                    ...value.privateSettings,
                    ...copyIn(data.sourceSettings),
                },
            })));
        case "GetSceneItemPrivateSettings":
            return unchanged(state, {
                sceneItemSettings: requireSceneItem(state, data.sceneName, data.sceneItemId).privateSettings,
            });
        case "SetSceneItemPrivateSettings":
            return changed(updateSceneItem(state, data.sceneName, data.sceneItemId, (item) => ({
                ...item,
                privateSettings: {
                    ...item.privateSettings,
                    ...copyIn(data.sceneItemSettings),
                },
            })));
        case "GetSourceFilterList":
            return unchanged(state, {
                filters: requireSource(state, data.sourceName).filters.map((value) => ({
                    filterName: value.name,
                    ...filterResponse(value),
                })),
            });
        case "GetSourceFilter":
            return unchanged(state, filterResponse(requireFilter(state, data.sourceName, data.filterName)));
        case "CreateSourceFilter": {
            const source = requireSource(state, data.sourceName);
            if (source.filters.some((value) => value.name === data.filterName)) {
                throw new RequestError(601, "A filter already exists by that name.");
            }
            const created = {
                name: data.filterName,
                kind: data.filterKind,
                settings: copyIn(data.filterSettings ?? {}),
                enabled: true,
                index: source.filters.length,
            };
            return changed(updateSource(state, data.sourceName, (value) => ({
                ...value,
                filters: [...value.filters, created],
            })));
        }
        case "RemoveSourceFilter": {
            requireFilter(state, data.sourceName, data.filterName);
            return changed(updateSource(state, data.sourceName, (value) => ({
                ...value,
                filters: reindex(value.filters.filter((filter) => filter.name !== data.filterName)),
            })));
        }
        case "SetSourceFilterSettings":
            requireFilter(state, data.sourceName, data.filterName);
            return changed(updateSource(state, data.sourceName, (value) => ({
                ...value,
                filters: value.filters.map((filter) => filter.name === data.filterName
                    ? {
                        ...filter,
                        settings: data.overlay === false
                            ? copyIn(data.filterSettings)
                            : {
                                ...filter.settings,
                                ...copyIn(data.filterSettings),
                            },
                    }
                    : filter),
            })));
        case "SetSourceFilterEnabled":
            requireFilter(state, data.sourceName, data.filterName);
            return changed(updateSource(state, data.sourceName, (value) => ({
                ...value,
                filters: value.filters.map((filter) => filter.name === data.filterName
                    ? { ...filter, enabled: data.filterEnabled }
                    : filter),
            })));
        case "SetSourceFilterIndex": {
            const source = requireSource(state, data.sourceName);
            const filter = requireFilter(state, data.sourceName, data.filterName);
            const without = source.filters.filter((value) => value.name !== filter.name);
            const index = Math.max(0, Math.min(data.filterIndex, without.length));
            return changed(updateSource(state, data.sourceName, (value) => ({
                ...value,
                filters: reindex([
                    ...without.slice(0, index),
                    filter,
                    ...without.slice(index),
                ]),
            })));
        }
        case "GetCurrentProgramScene": {
            // OBS always has a program scene; before one is set, report the first.
            const scene = state.currentProgramSceneName
                ? requireScene(state, state.currentProgramSceneName)
                : state.scenes[0];
            if (!scene) {
                throw new RequestError(605, "There is no current program scene.");
            }
            return unchanged(state, {
                sceneName: scene.name,
                sceneUuid: scene.uuid,
                currentProgramSceneName: scene.name,
                currentProgramSceneUuid: scene.uuid,
            });
        }
        case "GetCurrentPreviewScene": {
            if (!state.currentPreviewSceneName) {
                throw new RequestError(506, "Studio mode is not active.");
            }
            const scene = requireScene(state, state.currentPreviewSceneName);
            return unchanged(state, {
                sceneName: scene.name,
                sceneUuid: scene.uuid,
                currentPreviewSceneName: scene.name,
                currentPreviewSceneUuid: scene.uuid,
            });
        }
        case "SetCurrentProgramScene":
            requireScene(state, data.sceneName);
            return changed({ ...state, currentProgramSceneName: data.sceneName });
        case "SetCurrentPreviewScene":
            requireScene(state, data.sceneName);
            return changed({ ...state, currentPreviewSceneName: data.sceneName });
        case "GetSceneSceneTransitionOverride": {
            const scene = requireScene(state, data.sceneName);
            return unchanged(state, {
                transitionName: scene.transitionName,
                transitionDuration: scene.transitionDuration,
            });
        }
        case "SetSceneSceneTransitionOverride":
            return changed(updateScene(state, data.sceneName, (scene) => ({
                ...scene,
                ...(data.transitionName === undefined
                    ? {}
                    : { transitionName: data.transitionName }),
                ...(data.transitionDuration === undefined
                    ? {}
                    : { transitionDuration: data.transitionDuration }),
            })));
        case "Sleep":
            return unchanged(state);
        default:
            throw new RequestError(204, `The request type \`${requestType}\` is invalid or is not supported.`);
    }
};
const initialState = (options) => {
    let nextUuid = 1;
    let nextSceneItemId = 1;
    const inputs = (options.inputs ?? []).map((seed) => ({
        name: seed.name,
        uuid: `mock-input-${nextUuid++}`,
        kind: seed.kind,
        settings: copyIn(seed.settings ?? {}),
        privateSettings: copyIn(seed.privateSettings ?? {}),
        filters: (seed.filters ?? []).map(filterFromSeed),
        muted: seed.muted ?? false,
        volumeMul: seed.volumeMul ?? 1,
        audioBalance: seed.audioBalance ?? 0.5,
        audioSyncOffset: seed.audioSyncOffset ?? 0,
        audioMonitorType: seed.audioMonitorType ?? "OBS_MONITORING_TYPE_NONE",
        audioTracks: copyIn(seed.audioTracks ?? {}),
        propertyLists: copyIn(seed.propertyLists ?? {}),
    }));
    const inputByName = (name) => inputs.find((value) => value.name === name);
    const scenes = (options.scenes ?? []).map((seed) => ({
        name: seed.name,
        uuid: `mock-scene-${nextUuid++}`,
        privateSettings: copyIn(seed.privateSettings ?? {}),
        filters: (seed.filters ?? []).map(filterFromSeed),
        transitionName: seed.transitionName ?? null,
        transitionDuration: seed.transitionDuration ?? null,
        items: (seed.items ?? []).map((item, index) => {
            const id = item.id ?? nextSceneItemId++;
            nextSceneItemId = Math.max(nextSceneItemId, id + 1);
            return {
                sourceName: item.sourceName,
                id,
                enabled: item.enabled ?? true,
                locked: item.locked ?? false,
                transform: {
                    ...defaultTransform(inputByName(item.sourceName)),
                    ...copyIn(item.transform ?? {}),
                },
                blendMode: item.blendMode ?? "OBS_BLEND_NORMAL",
                privateSettings: copyIn(item.privateSettings ?? {}),
                index,
            };
        }),
    }));
    return {
        inputs,
        scenes,
        currentProgramSceneName: options.currentProgramSceneName ?? scenes[0]?.name ?? null,
        currentPreviewSceneName: options.currentPreviewSceneName ?? null,
        nextUuid,
        nextSceneItemId,
    };
};
/**
 * Creates a stateful OBSSocket implementation without opening a WebSocket.
 * Requests reduce one immutable state value into the next state value.
 */
export const make = (options = {}) => {
    let state = deepFreeze(initialState(options));
    let calls = [];
    let batches = [];
    let service;
    const occurrences = new Map();
    const ws = {
        call: (requestType, requestData) => {
            if (!service) {
                throw new Error("Mock OBSSocket is not initialized");
            }
            return Effect.runPromise(service.call(requestType, requestData));
        },
    };
    const execute = (requestType, requestData, batch) => {
        const data = copyIn(requestData ?? {});
        calls = Object.freeze([
            ...calls,
            {
                requestType,
                ...(requestData === undefined ? {} : { requestData: data }),
                ...(batch === undefined ? {} : { batch }),
            },
        ]);
        const occurrence = (occurrences.get(requestType) ?? 0) + 1;
        occurrences.set(requestType, occurrence);
        const failure = options.failures?.find((value) => value.requestType === requestType &&
            (value.occurrence ?? 1) === occurrence);
        try {
            if (failure && (failure.phase ?? "before") === "before") {
                throw new RequestError(failure.code ?? 500, failure.message);
            }
            const reduction = reduceRequest(state, requestType, data);
            state = deepFreeze(reduction.state);
            if (failure?.phase === "after") {
                throw new RequestError(failure.code ?? 500, failure.message);
            }
            return { _tag: "Success", response: reduction.response };
        }
        catch (cause) {
            const error = typeof cause === "object" && cause !== null ? cause : {};
            const message = "message" in error ? error.message : undefined;
            const code = "code" in error ? error.code : undefined;
            return {
                _tag: "Failure",
                code: typeof code === "number" ? code : 500,
                message: String(message),
            };
        }
    };
    const delayed = (effect) => options.requestDelayMs
        ? Effect.sleep(options.requestDelayMs).pipe(Effect.andThen(effect))
        : effect;
    const initializedService = {
        call: (requestType, requestData) => makeCall(delayed(Effect.suspend(() => {
            const outcome = execute(requestType, requestData);
            return outcome._tag === "Success"
                ? Effect.succeed(outcome.response)
                : Effect.fail(new OBSError({
                    message: `OBS request "${requestType}" failed: Error: ${outcome.message}`,
                    cause: { code: outcome.code, message: outcome.message },
                }));
        })), requestType, requestData),
        batch: (calls, batchOptions = {}) => {
            const requests = calls.map((call) => call[OBSCallTypeId]);
            if (requests.length === 0) {
                return Effect.succeed([]);
            }
            return delayed(Effect.suspend(() => {
                const batch = batches.length;
                batches = Object.freeze([
                    ...batches,
                    Object.freeze({
                        requests: Object.freeze(requests.map((request) => copyIn({ ...request }))),
                        options: copyIn(batchOptions),
                    }),
                ]);
                const responses = [];
                for (const [index, request] of requests.entries()) {
                    const outcome = execute(request.requestType, request.requestData, batch);
                    responses.push(outcome._tag === "Success"
                        ? {
                            requestId: String(index),
                            requestStatus: { result: true, code: 100 },
                            responseData: outcome.response,
                        }
                        : {
                            requestId: String(index),
                            requestStatus: {
                                result: false,
                                code: outcome.code,
                                comment: outcome.message,
                            },
                        });
                    if (outcome._tag === "Failure" && batchOptions.haltOnFailure) {
                        break;
                    }
                }
                return collectBatchResponses(requests, responses);
            }));
        },
    };
    service = initializedService;
    return {
        service: initializedService,
        layer: Layer.succeed(OBSSocket, initializedService),
        /**
         * An obs-websocket-js shaped client backed by the same memory state.
         */
        ws,
        get calls() {
            return calls;
        },
        get batches() {
            return batches;
        },
        snapshot: () => state,
    };
};
export const layer = (options = {}) => make(options).layer;
//# sourceMappingURL=MockOBSSocket.js.map