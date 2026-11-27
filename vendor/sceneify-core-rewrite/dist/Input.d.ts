import { Effect } from "effect";
import type { OBSError } from "./errors.ts";
import * as Filter from "./Filter.ts";
import type { FilterType } from "./FilterType.ts";
import type { InputType, InputTypeSettings } from "./InputType.ts";
import { OBSSocket } from "./OBSSocket.ts";
export type AudioMonitorType = "none" | "monitorOnly" | "monitorAndOutput";
/**
 * Represents a declared input with its type, name, settings, and optional filters.
 * TType is the InputType class (e.g. typeof BrowserSource).
 * TFilters is a record mapping filter keys to inline FilterConfigs.
 */
export interface Declaration<TType extends InputType, TFilters extends Record<string, FilterType> = {}> {
    readonly type: TType;
    readonly name: string;
    readonly settings: Partial<InputTypeSettings<TType>>;
    readonly filters: FiltersDeclaration<TFilters>;
}
export type DeclarationType<T extends Declaration<any, any>> = T extends Declaration<infer Type, any> ? Type : never;
export type DeclarationFilters<T extends Declaration<any, any>> = T extends Declaration<any, infer Filters> ? Filters : never;
/**
 * Runtime representation of an input in OBS.
 * OBSSocket is captured at creation time - methods return Effects
 * that do not require OBSSocket in context.
 */
export interface Input<TType extends InputType<string, any>, TFilters extends Record<string, FilterType>> {
    /** The input name in OBS */
    readonly name: string;
    /** The OBS input kind */
    readonly kind: string;
    /** Set input settings (partial update) */
    readonly setSettings: (settings: Partial<InputTypeSettings<TType>>) => Effect.Effect<void, OBSError>;
    /** Get current input settings */
    readonly getSettings: () => Effect.Effect<InputTypeSettings<TType>, OBSError>;
    /** Get mute state */
    readonly getMuted: () => Effect.Effect<boolean, OBSError>;
    /** Set mute state */
    readonly setMuted: (muted: boolean) => Effect.Effect<void, OBSError>;
    /** Toggle mute state, returns new state */
    readonly toggleMuted: () => Effect.Effect<boolean, OBSError>;
    /** Get volume (returns { db, mul }) */
    readonly getVolume: () => Effect.Effect<{
        db: number;
        mul: number;
    }, OBSError>;
    /** Set volume (accepts { db } or { mul }) */
    readonly setVolume: (volume: {
        db: number;
    } | {
        mul: number;
    }) => Effect.Effect<void, OBSError>;
    /** Get audio sync offset in milliseconds */
    readonly getAudioSyncOffset: () => Effect.Effect<number, OBSError>;
    /** Set audio sync offset in milliseconds */
    readonly setAudioSyncOffset: (offset: number) => Effect.Effect<void, OBSError>;
    readonly getAudioBalance: () => Effect.Effect<number, OBSError>;
    readonly setAudioBalance: (balance: number) => Effect.Effect<void, OBSError>;
    readonly getAudioMonitorType: () => Effect.Effect<AudioMonitorType, OBSError>;
    /** Set audio monitor type */
    readonly setAudioMonitorType: (type: AudioMonitorType) => Effect.Effect<void, OBSError>;
    readonly getAudioTracks: () => Effect.Effect<Record<string, boolean>, OBSError>;
    readonly setAudioTracks: (tracks: Readonly<Record<string, boolean>>) => Effect.Effect<void, OBSError>;
    /** Get all filters on this input */
    readonly getFilters: () => Effect.Effect<Array<{
        filterEnabled: boolean;
        filterIndex: number;
        filterKind: string;
        filterName: string;
        filterSettings: Record<string, unknown>;
    }>, OBSError>;
    /** Access a declared filter by key */
    readonly filter: <K extends keyof TFilters>(key: K) => Filter.Filter<TFilters[K]>;
    readonly getPropertyListItems: (property: keyof InputTypeSettings<TType> & string) => Effect.Effect<{
        name: string;
        enabled: boolean;
        value?: string | number;
    }[], OBSError>;
    readonly pressPropertyButton: (property: string) => Effect.Effect<void, OBSError>;
}
type FiltersDeclaration<TFilters extends Record<string, FilterType>> = {
    [K in keyof TFilters]: Filter.Config<TFilters[K]>;
};
/**
 * Declare an input instance from an InputType class.
 *
 * Settings are type-checked against the InputType's settings type.
 * Filters are defined inline with their type, name, and optional settings/enabled.
 *
 * Usage:
 * ```ts
 * const chatBrowser = Input.declare(BrowserSource, {
 *   name: "Chat Browser",
 *   settings: { url: "https://twitch.tv/chat", width: 1920 },
 *   filters: {
 *     colorFix: {
 *       type: ColorCorrection,
 *       name: "Color Fix",
 *       settings: { gamma: 1.5 },
 *     },
 *   },
 * });
 * ```
 */
type DeclarationOptions<TType extends InputType<any, any>, TFilters extends Record<string, FilterType>> = {
    name: string;
    settings?: Partial<InputTypeSettings<TType>>;
    filters?: FiltersDeclaration<TFilters>;
};
export declare const declare: <TType extends InputType<any, any>, TFilters extends Record<string, FilterType<string, any>> = {}>(type: TType, options: DeclarationOptions<TType, TFilters>) => Declaration<TType, TFilters>;
/**
 * Makes an Input object from name, kind, and filters
 * The OBSSocket is captured at creation and used for all subsequent calls.
 */
export declare const make: <TType extends InputType<string, any>, TFilters extends Record<string, FilterType<string, any>> = {}>(name: string, kind: string, filters?: Partial<{ [K in keyof TFilters]: Filter.Filter<TFilters[K]>; }> | undefined) => Effect.Effect<Input<TType, TFilters>, never, OBSSocket>;
export {};
//# sourceMappingURL=Input.d.ts.map