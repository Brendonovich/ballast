import { Effect } from "effect";
import * as Filter from "./Filter.js";
import { OBSSocket, } from "./OBSSocket.js";
const monitorTypeMap = {
    none: "OBS_MONITORING_TYPE_NONE",
    monitorOnly: "OBS_MONITORING_TYPE_MONITOR_ONLY",
    monitorAndOutput: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT",
};
const monitorTypeByOBS = Object.fromEntries(Object.entries(monitorTypeMap).map(([type, obsType]) => [obsType, type]));
export const declare = (type, options) => {
    const settings = options.settings ?? {};
    return {
        type,
        name: options.name,
        settings,
        filters: options.filters ?? {},
    };
};
/**
 * Makes an Input object from name, kind, and filters
 * The OBSSocket is captured at creation and used for all subsequent calls.
 */
export const make = Effect.fnUntraced(function* (name, kind, filters = {}) {
    const obs = yield* OBSSocket;
    const input = {
        name,
        kind,
        setSettings: (settings) => Effect.gen(function* () {
            yield* obs.call("SetInputSettings", {
                inputName: name,
                inputSettings: settings,
            });
        }),
        getSettings: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputSettings", {
                inputName: name,
            });
            return result.inputSettings;
        }),
        getMuted: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputMute", {
                inputName: name,
            });
            return result.inputMuted;
        }),
        setMuted: (muted) => Effect.gen(function* () {
            yield* obs.call("SetInputMute", {
                inputName: name,
                inputMuted: muted,
            });
        }),
        toggleMuted: () => Effect.gen(function* () {
            const result = yield* obs.call("ToggleInputMute", {
                inputName: name,
            });
            return result.inputMuted;
        }),
        getVolume: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputVolume", {
                inputName: name,
            });
            return {
                db: result.inputVolumeDb,
                mul: result.inputVolumeMul,
            };
        }),
        setVolume: (volume) => Effect.gen(function* () {
            const data = { inputName: name };
            if ("db" in volume) {
                data.inputVolumeDb = volume.db;
            }
            else {
                data.inputVolumeMul = volume.mul;
            }
            yield* obs.call("SetInputVolume", data);
        }),
        getAudioSyncOffset: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputAudioSyncOffset", {
                inputName: name,
            });
            return result.inputAudioSyncOffset;
        }),
        setAudioSyncOffset: (offset) => Effect.gen(function* () {
            yield* obs.call("SetInputAudioSyncOffset", {
                inputName: name,
                inputAudioSyncOffset: offset,
            });
        }),
        getAudioBalance: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputAudioBalance", {
                inputName: name,
            });
            return result.inputAudioBalance;
        }),
        setAudioBalance: (balance) => Effect.gen(function* () {
            yield* obs.call("SetInputAudioBalance", {
                inputName: name,
                inputAudioBalance: balance,
            });
        }),
        getAudioMonitorType: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputAudioMonitorType", {
                inputName: name,
            });
            return monitorTypeByOBS[result.monitorType];
        }),
        setAudioMonitorType: (type) => Effect.gen(function* () {
            yield* obs.call("SetInputAudioMonitorType", {
                inputName: name,
                monitorType: monitorTypeMap[type],
            });
        }),
        getAudioTracks: () => Effect.gen(function* () {
            const result = yield* obs.call("GetInputAudioTracks", {
                inputName: name,
            });
            return result.inputAudioTracks;
        }),
        setAudioTracks: (tracks) => Effect.gen(function* () {
            yield* obs.call("SetInputAudioTracks", {
                inputName: name,
                inputAudioTracks: tracks,
            });
        }),
        getFilters: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSourceFilterList", {
                sourceName: name,
            });
            return result.filters;
        }),
        filter: (key) => {
            const f = filters[key];
            if (!f) {
                throw new Error(`Filter "${String(key)}" not found on input "${name}". Available filters: ${Object.keys(filters).join(", ")}`);
            }
            return f;
        },
        getPropertyListItems: (property) => obs
            .call("GetInputPropertiesListPropertyItems", {
            inputName: name,
            propertyName: property,
        })
            .pipe(Effect.map((v) => v.propertyItems.map((v) => ({
            name: v.itemName,
            enabled: v.itemEnabled,
            ...(v.itemValue === undefined ? {} : { value: v.itemValue }),
        })))),
        pressPropertyButton: (property) => obs.call("PressInputPropertiesButton", {
            inputName: name,
            propertyName: property,
        }),
    };
    return input;
});
//# sourceMappingURL=Input.js.map