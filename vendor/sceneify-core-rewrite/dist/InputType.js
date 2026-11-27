import * as Schema from "effect/Schema";
import { makeSettingsSchema, } from "./SettingsSchema.js";
const InputTypeSettingsBrand = Symbol.for("@sceneify/core-rewrite/InputTypeSettings");
/**
 * Creates an InputType for a given OBS input kind.
 *
 * Usage:
 * ```ts
 * class BrowserSource extends InputType("browser_source", {
 *   url: Schema.String,
 *   width: Schema.Number,
 * }) {}
 *
 * BrowserSource.kind // "browser_source"
 * type Settings = InputTypeSettings<typeof BrowserSource>; // { url: string; width: number; }
 * ```
 */
export const InputType = (kind, fields) => {
    const schema = makeSettingsSchema(fields);
    const cls = class {
        static kind = kind;
        static schema = schema;
    };
    return cls;
};
//# sourceMappingURL=InputType.js.map