import * as Schema from "effect/Schema";
import { type SettingsFieldsType } from "./SettingsSchema.ts";
declare const FilterTypeSettingsBrand: unique symbol;
/**
 * Phantom interface that carries the Settings type at the type level.
 */
export interface FilterTypeBrand<Settings> {
    readonly [FilterTypeSettingsBrand]: Settings;
}
/**
 * A class constructor that carries an OBS kind and settings schema.
 * This is what `FilterType(kind, fields)` returns.
 */
export interface FilterType<Kind extends string = string, Settings = any> extends FilterTypeBrand<Settings> {
    readonly kind: Kind;
    readonly schema: Schema.Codec<Settings, unknown>;
    new (_: never): {};
}
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
export declare const FilterType: <const Kind extends string, Fields extends Schema.Struct.Fields>(kind: Kind, fields: Fields) => FilterType<Kind, SettingsFieldsType<Fields>>;
/**
 * Extracts the Settings type from a FilterType class.
 *
 * Usage:
 * ```ts
 * type Settings = FilterTypeSettings<typeof ColorCorrection>;
 * // => { gamma: number; contrast: number; }
 * ```
 */
export type FilterTypeSettings<T> = T extends FilterType<any, infer Settings> ? Settings : never;
export {};
//# sourceMappingURL=FilterType.d.ts.map