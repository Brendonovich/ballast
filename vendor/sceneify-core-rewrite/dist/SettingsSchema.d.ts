import * as Schema from "effect/Schema";
export type SettingsFields = Schema.Struct.Fields;
export type SettingsFieldsType<Fields extends SettingsFields> = Schema.Schema.Type<Schema.Struct<Fields>>;
export declare const makeSettingsSchema: <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.Codec<Schema.Struct.View<Fields, "Type", Schema.Struct.TypeOptionalKeys<Fields>, Schema.Struct.TypeMutableKeys<Fields>>, unknown, never, never>;
//# sourceMappingURL=SettingsSchema.d.ts.map