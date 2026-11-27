import { Effect, Ref, Semaphore } from "effect";
import { InvalidDeclarationError, NameConflictError } from "./errors.js";
import * as Filter from "./Filter.js";
import * as Input from "./Input.js";
import { OBSSocket, } from "./OBSSocket.js";
import * as SceneItem from "./SceneItem.js";
const validateIndex = (description, index) => {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
        return new InvalidDeclarationError({
            message: `${description} index must be a non-negative integer`,
        });
    }
};
const validateUniqueIndexes = (description, values) => {
    const indexes = values.filter((value) => value !== undefined);
    if (new Set(indexes).size !== indexes.length) {
        return new InvalidDeclarationError({
            message: `${description} contains duplicate indexes`,
        });
    }
};
const validateFilters = (sourceName, declarations) => {
    const entries = Object.entries(declarations);
    const names = entries.map(([, filter]) => filter.name);
    if (new Set(names).size !== names.length) {
        return new InvalidDeclarationError({
            message: `Source "${sourceName}" contains duplicate filter names`,
        });
    }
    for (const [key, filter] of entries) {
        const error = validateIndex(`Filter "${key}" on "${sourceName}"`, filter.index);
        if (error)
            return error;
    }
    return validateUniqueIndexes(`Filters on "${sourceName}"`, entries.map(([, filter]) => filter.index));
};
export const makeSceneSync = (registry, obs) => Effect.gen(function* () {
    const pendingRef = yield* Ref.make(new Set());
    const pendingItemIdsRef = yield* Ref.make(new Map());
    const syncSemaphore = yield* Semaphore.make(1);
    const markPending = (key) => Ref.update(pendingRef, (values) => new Set(values).add(key));
    const isPending = (key) => Ref.get(pendingRef).pipe(Effect.map((values) => values.has(key)));
    const clearPending = (key) => Ref.update(pendingRef, (values) => {
        const next = new Set(values);
        next.delete(key);
        return next;
    }).pipe(Effect.andThen(Ref.update(pendingItemIdsRef, (values) => {
        const next = new Map(values);
        next.delete(key);
        return next;
    })));
    const markPendingItem = (key, existingIds) => markPending(key).pipe(Effect.andThen(Ref.update(pendingItemIdsRef, (values) => {
        const next = new Map(values);
        next.set(key, new Set(existingIds));
        return next;
    })));
    const getPendingItemIds = (key) => Ref.get(pendingItemIdsRef).pipe(Effect.map((values) => values.get(key) ?? new Set()));
    function sync(declaration) {
        const reconcile = Effect.gen(function* () {
            const declaredItems = Object.entries(declaration.items);
            const itemIndexes = [];
            for (const [key, item] of declaredItems) {
                const error = validateIndex(`Scene item "${key}"`, item.index);
                if (error)
                    return yield* error;
                itemIndexes.push(item.index);
            }
            const itemIndexError = validateUniqueIndexes(`Scene "${declaration.name}"`, itemIndexes);
            if (itemIndexError)
                return yield* itemIndexError;
            const inputsByName = new Map();
            for (const [, item] of declaredItems) {
                const existing = inputsByName.get(item.source.name);
                if (existing && existing !== item.source) {
                    if (existing.type.kind !== item.source.type.kind) {
                        return yield* new NameConflictError({
                            name: item.source.name,
                            expectedKind: existing.type.kind,
                            actualKind: item.source.type.kind,
                        });
                    }
                    return yield* new InvalidDeclarationError({
                        message: `Input "${item.source.name}" has multiple declarations`,
                    });
                }
                inputsByName.set(item.source.name, item.source);
            }
            const sceneFilterError = validateFilters(declaration.name, declaration.filters);
            if (sceneFilterError)
                return yield* sceneFilterError;
            for (const input of inputsByName.values()) {
                const inputFilterError = validateFilters(input.name, input.filters);
                if (inputFilterError)
                    return yield* inputFilterError;
            }
            const getSourceData = (sourceName) => obs
                .call("GetSourcePrivateSettings", { sourceName })
                .pipe(Effect.map(({ sourceSettings }) => sourceSettings.SCENEIFY ?? undefined));
            const setSourceData = (sourceName, sourceData) => obs.call("SetSourcePrivateSettings", {
                sourceName,
                sourceSettings: { SCENEIFY: sourceData },
            });
            const reconcileFilters = (sourceName, declarations) => Effect.gen(function* () {
                const entries = Object.entries(declarations);
                const { filters } = yield* obs.call("GetSourceFilterList", {
                    sourceName,
                });
                const actualFilters = filters;
                const sourceData = yield* getSourceData(sourceName);
                const originalMetadata = [...(sourceData?.filters ?? [])];
                let metadata = [...originalMetadata];
                const nextMetadata = [];
                const runtimes = {};
                for (const [key, filterDeclaration] of entries) {
                    const actual = actualFilters.find((filter) => filter.filterName === filterDeclaration.name);
                    const owned = metadata.find((filter) => filter.name === filterDeclaration.name);
                    const pendingKey = `filter:${sourceName}:${filterDeclaration.name}`;
                    const pending = yield* isPending(pendingKey);
                    if (actual) {
                        if (actual.filterKind !== filterDeclaration.type.kind) {
                            return yield* new NameConflictError({
                                name: `${sourceName}/${filterDeclaration.name}`,
                                expectedKind: filterDeclaration.type.kind,
                                actualKind: actual.filterKind,
                            });
                        }
                        if (!owned && !pending) {
                            return yield* new NameConflictError({
                                name: `${sourceName}/${filterDeclaration.name}`,
                            });
                        }
                    }
                    else {
                        yield* markPending(pendingKey);
                        yield* obs.call("CreateSourceFilter", {
                            sourceName,
                            filterName: filterDeclaration.name,
                            filterKind: filterDeclaration.type.kind,
                            filterSettings: filterDeclaration.settings ?? {},
                        });
                    }
                    const entry = {
                        key,
                        name: filterDeclaration.name,
                    };
                    nextMetadata.push(entry);
                    metadata = [
                        ...metadata.filter((value) => value.name !== filterDeclaration.name),
                        entry,
                    ];
                    yield* setSourceData(sourceName, {
                        filters: metadata,
                    });
                    yield* clearPending(pendingKey);
                    yield* obs.call("SetSourceFilterSettings", {
                        sourceName,
                        filterName: filterDeclaration.name,
                        filterSettings: filterDeclaration.settings ?? {},
                    });
                    yield* obs.call("SetSourceFilterEnabled", {
                        sourceName,
                        filterName: filterDeclaration.name,
                        filterEnabled: filterDeclaration.enabled ?? true,
                    });
                    runtimes[key] = (yield* Filter.make(filterDeclaration.name, sourceName));
                }
                for (const stale of originalMetadata) {
                    if (nextMetadata.some((value) => value.name === stale.name)) {
                        continue;
                    }
                    if (actualFilters.some((filter) => filter.filterName === stale.name)) {
                        yield* obs.call("RemoveSourceFilter", {
                            sourceName,
                            filterName: stale.name,
                        });
                    }
                }
                yield* setSourceData(sourceName, {
                    ...(nextMetadata.length > 0 ? { filters: nextMetadata } : {}),
                });
                const indexedEntries = entries.filter((entry) => entry[1].index !== undefined);
                for (const [, filterDeclaration] of indexedEntries.sort(([, a], [, b]) => a.index - b.index)) {
                    yield* obs.call("SetSourceFilterIndex", {
                        sourceName,
                        filterName: filterDeclaration.name,
                        filterIndex: filterDeclaration.index,
                    });
                }
                return runtimes;
            });
            const inputList = yield* obs.call("GetInputList");
            const actualInputs = new Map(inputList.inputs.map((input) => [input.inputName, input]));
            const inputPreflight = new Map();
            // Detect input conflicts before creating or claiming any resources.
            for (const inputDeclaration of inputsByName.values()) {
                const actual = actualInputs.get(inputDeclaration.name);
                if (!actual)
                    continue;
                if (actual.inputKind !== inputDeclaration.type.kind) {
                    return yield* new NameConflictError({
                        name: inputDeclaration.name,
                        expectedKind: inputDeclaration.type.kind,
                        actualKind: actual.inputKind,
                    });
                }
                const sourceData = yield* getSourceData(inputDeclaration.name);
                const pending = yield* isPending(inputDeclaration.name);
                if (!sourceData && !pending) {
                    return yield* new NameConflictError({
                        name: inputDeclaration.name,
                    });
                }
                inputPreflight.set(inputDeclaration.name, { sourceData, pending });
            }
            const { scenes } = yield* obs.call("GetSceneList");
            const sceneExists = scenes.some((scene) => scene.sceneName === declaration.name);
            const pendingSceneKey = `scene:${declaration.name}`;
            if (!sceneExists) {
                yield* markPending(pendingSceneKey);
                yield* obs.call("CreateScene", { sceneName: declaration.name });
                yield* setSourceData(declaration.name, {});
                yield* clearPending(pendingSceneKey);
            }
            else {
                const sourceData = yield* getSourceData(declaration.name);
                if (!sourceData) {
                    if (yield* isPending(pendingSceneKey)) {
                        yield* setSourceData(declaration.name, {});
                        yield* clearPending(pendingSceneKey);
                    }
                    else {
                        return yield* new NameConflictError({ name: declaration.name });
                    }
                }
            }
            const sceneFilterInstances = yield* reconcileFilters(declaration.name, declaration.filters);
            const createdInputItems = new Map();
            const recoveredInputs = new Set();
            const inputFilterInstances = new Map();
            for (const inputDeclaration of inputsByName.values()) {
                const actual = actualInputs.get(inputDeclaration.name);
                if (!actual) {
                    yield* markPending(inputDeclaration.name);
                    const created = yield* obs.call("CreateInput", {
                        sceneName: declaration.name,
                        inputName: inputDeclaration.name,
                        inputKind: inputDeclaration.type.kind,
                        inputSettings: inputDeclaration.settings,
                    });
                    createdInputItems.set(inputDeclaration.name, created.sceneItemId);
                    yield* setSourceData(inputDeclaration.name, {});
                }
                else {
                    const { sourceData, pending } = inputPreflight.get(inputDeclaration.name);
                    if (!sourceData) {
                        recoveredInputs.add(inputDeclaration.name);
                        yield* setSourceData(inputDeclaration.name, {});
                        yield* clearPending(inputDeclaration.name);
                    }
                    else if (pending) {
                        recoveredInputs.add(inputDeclaration.name);
                    }
                    if (Object.keys(inputDeclaration.settings).length > 0) {
                        yield* obs.call("SetInputSettings", {
                            inputName: inputDeclaration.name,
                            inputSettings: inputDeclaration.settings,
                        });
                    }
                }
                inputFilterInstances.set(inputDeclaration.name, yield* reconcileFilters(inputDeclaration.name, inputDeclaration.filters));
            }
            const { sceneItems } = yield* obs.call("GetSceneItemList", {
                sceneName: declaration.name,
            });
            const currentItems = [];
            for (const item of sceneItems) {
                const { sceneItemSettings } = yield* obs.call("GetSceneItemPrivateSettings", {
                    sceneName: declaration.name,
                    sceneItemId: item.sceneItemId,
                });
                currentItems.push({
                    ...item,
                    ...(sceneItemSettings.SCENEIFY
                        ? { metadata: sceneItemSettings.SCENEIFY }
                        : {}),
                });
            }
            const consumedItemIds = new Set();
            const runtimeItems = {};
            const orderedItems = [];
            for (const [key, itemDeclaration] of declaredItems) {
                const candidates = currentItems.filter((item) => item.sourceName === itemDeclaration.source.name &&
                    !consumedItemIds.has(item.sceneItemId));
                const pendingItemKey = `item:${declaration.name}:${key}`;
                const pendingItem = yield* isPending(pendingItemKey);
                const pendingItemIds = yield* getPendingItemIds(pendingItemKey);
                let current = candidates.find((item) => item.metadata?.key === key);
                if (!current) {
                    const createdId = createdInputItems.get(itemDeclaration.source.name);
                    if (createdId !== undefined && !consumedItemIds.has(createdId)) {
                        current = candidates.find((item) => item.sceneItemId === createdId);
                    }
                }
                if (!current && recoveredInputs.has(itemDeclaration.source.name)) {
                    current = candidates
                        .filter((item) => !item.metadata)
                        .sort((a, b) => a.sceneItemIndex - b.sceneItemIndex)[0];
                }
                if (!current && pendingItem) {
                    current = candidates
                        .filter((item) => !item.metadata && !pendingItemIds.has(item.sceneItemId))
                        .sort((a, b) => a.sceneItemIndex - b.sceneItemIndex)[0];
                }
                let sceneItemId;
                if (current) {
                    sceneItemId = current.sceneItemId;
                }
                else {
                    yield* markPendingItem(pendingItemKey, candidates.map((item) => item.sceneItemId));
                    const created = yield* obs.call("CreateSceneItem", {
                        sceneName: declaration.name,
                        sourceName: itemDeclaration.source.name,
                        sceneItemEnabled: itemDeclaration.enabled ?? true,
                    });
                    sceneItemId = created.sceneItemId;
                }
                consumedItemIds.add(sceneItemId);
                yield* obs.call("SetSceneItemPrivateSettings", {
                    sceneName: declaration.name,
                    sceneItemId,
                    sceneItemSettings: {
                        SCENEIFY: { key },
                    },
                });
                yield* clearPending(pendingItemKey);
                if (yield* isPending(itemDeclaration.source.name)) {
                    yield* clearPending(itemDeclaration.source.name);
                }
                if (itemDeclaration.transform) {
                    yield* obs.call("SetSceneItemTransform", {
                        sceneName: declaration.name,
                        sceneItemId,
                        sceneItemTransform: itemDeclaration.transform,
                    });
                }
                yield* obs.call("SetSceneItemEnabled", {
                    sceneName: declaration.name,
                    sceneItemId,
                    sceneItemEnabled: itemDeclaration.enabled ?? true,
                });
                yield* obs.call("SetSceneItemLocked", {
                    sceneName: declaration.name,
                    sceneItemId,
                    sceneItemLocked: itemDeclaration.lock ?? false,
                });
                if (itemDeclaration.index !== undefined) {
                    orderedItems.push({
                        id: sceneItemId,
                        index: itemDeclaration.index,
                    });
                }
                const inputInstance = yield* Input.make(itemDeclaration.source.name, itemDeclaration.source.type.kind, inputFilterInstances.get(itemDeclaration.source.name));
                runtimeItems[key] = (yield* SceneItem.make(sceneItemId, declaration.name, inputInstance, true));
            }
            for (const stale of currentItems) {
                if (consumedItemIds.has(stale.sceneItemId) || !stale.metadata) {
                    continue;
                }
                yield* obs.call("RemoveSceneItem", {
                    sceneName: declaration.name,
                    sceneItemId: stale.sceneItemId,
                });
            }
            for (const item of orderedItems.sort((a, b) => a.index - b.index)) {
                yield* obs.call("SetSceneItemIndex", {
                    sceneName: declaration.name,
                    sceneItemId: item.id,
                    sceneItemIndex: item.index,
                });
            }
            for (const inputDeclaration of inputsByName.values()) {
                yield* registry.registerInput({ name: inputDeclaration.name });
            }
            const sceneName = declaration.name;
            const createItem = (config) => Effect.gen(function* () {
                const { inputs } = yield* obs.call("GetInputList");
                const existing = inputs.find((input) => input.inputName === config.name);
                let sceneItemId;
                if (existing) {
                    if (existing.inputKind !== config.type.kind) {
                        return yield* new NameConflictError({
                            name: config.name,
                            expectedKind: config.type.kind,
                            actualKind: existing.inputKind,
                        });
                    }
                    const sourceData = yield* getSourceData(config.name);
                    if (!sourceData) {
                        return yield* new NameConflictError({ name: config.name });
                    }
                    const created = yield* obs.call("CreateSceneItem", {
                        sceneName,
                        sourceName: config.name,
                    });
                    sceneItemId = created.sceneItemId;
                }
                else {
                    const created = yield* obs.call("CreateInput", {
                        sceneName,
                        inputName: config.name,
                        inputKind: config.type.kind,
                        inputSettings: (config.settings ?? {}),
                    });
                    sceneItemId = created.sceneItemId;
                    yield* setSourceData(config.name, {});
                }
                yield* registry.registerInput({ name: config.name });
                const inputInstance = yield* Input.make(config.name, config.type.kind);
                return yield* SceneItem.make(sceneItemId, sceneName, inputInstance, false);
            }).pipe(Effect.provideService(OBSSocket, obs));
            const scene = {
                name: sceneName,
                item: (key) => runtimeItems[key],
                filter: (key) => sceneFilterInstances[key],
                createItem,
                getTransitionOverride: () => obs.call("GetSceneSceneTransitionOverride", { sceneName }),
                setTransitionOverride: (options) => obs.call("SetSceneSceneTransitionOverride", {
                    sceneName,
                    ...options,
                }),
                makeProgramScene: obs.call("SetCurrentProgramScene", { sceneName }),
                makePreviewScene: obs.call("SetCurrentPreviewScene", { sceneName }),
            };
            return scene;
        });
        return syncSemaphore
            .withPermits(1)(reconcile)
            .pipe(Effect.provideService(OBSSocket, obs));
    }
    return {
        sync,
        clear: Ref.set(pendingRef, new Set()).pipe(Effect.andThen(Ref.set(pendingItemIdsRef, new Map()))),
    };
});
//# sourceMappingURL=SceneSync.js.map