import { Effect } from "effect";
import { OBSSocket } from "./OBSSocket.js";
/**
 * Creates a Filter from a filter name and its parent source name.
 * The OBSSocket is captured at creation and used for all subsequent calls.
 */
export const make = Effect.fnUntraced(function* (name, sourceName) {
    const obs = yield* OBSSocket;
    const filter = {
        name,
        sourceName,
        getInfo: () => Effect.gen(function* () {
            const result = yield* obs.call("GetSourceFilter", {
                sourceName,
                filterName: name,
            });
            return {
                settings: result.filterSettings,
                enabled: result.filterEnabled,
                index: result.filterIndex,
                kind: result.filterKind,
            };
        }),
        setSettings: (settings) => Effect.gen(function* () {
            yield* obs.call("SetSourceFilterSettings", {
                sourceName,
                filterName: name,
                filterSettings: settings,
            });
        }),
        setEnabled: (enabled) => Effect.gen(function* () {
            yield* obs.call("SetSourceFilterEnabled", {
                sourceName,
                filterName: name,
                filterEnabled: enabled,
            });
        }),
        setIndex: (index) => Effect.gen(function* () {
            yield* obs.call("SetSourceFilterIndex", {
                sourceName,
                filterName: name,
                filterIndex: index,
            });
        }),
    };
    return filter;
});
//# sourceMappingURL=Filter.js.map