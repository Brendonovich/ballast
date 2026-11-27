import * as Schema from "effect/Schema";
import { makeSettingsSchema, } from "./SettingsSchema.js";
const FilterTypeSettingsBrand = Symbol.for("@sceneify/core-rewrite/FilterTypeSettings");
/**
 * Creates a FilterType for a given OBS filter kind.
 *
 * Usage:
 * ```ts
 * class ColorCorrection extends FilterType("color_filter_v2", {
 *   gamma: Schema.Number,
 *   contrast: Schema.Number,
 * }) {}
 *
 * ColorCorrection.kind // "color_filter_v2"
 * type Settings = FilterTypeSettings<typeof ColorCorrection>; // { gamma: number; contrast: number; }
 * ```
 */
export const FilterType = (kind, fields) => {
    const schema = makeSettingsSchema(fields);
    const cls = class {
        static kind = kind;
        static schema = schema;
    };
    return cls;
};
//# sourceMappingURL=FilterType.js.map