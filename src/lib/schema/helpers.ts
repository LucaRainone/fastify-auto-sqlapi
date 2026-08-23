import { Type, OptionalKind, type TSchema } from '@sinclair/typebox';
import type { ITable, SchemaDefinition, DbTables, JoinDefinition } from '../../types.js';
import { readableFieldNames } from '../read-access.js';
import { Nullable } from '../nullable.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';

/**
 * Build a PK-only schema for response shapes (single or composite PK).
 * Falls back to `fallback` field if tableConf is undefined.
 */
export function pkSchema(tableConf: ITable | undefined, schema: SchemaDefinition, fallback: string): Record<string, TSchema> {
  const pk = tableConf?.primary || fallback;
  const fields = Array.isArray(pk) ? pk : [pk];
  const result: Record<string, TSchema> = {};
  for (const f of fields) {
    result[f] = schema.fields[f] || Type.Any();
  }
  return result;
}

/**
 * Build secondary table fields for body schemas:
 * - FK field becomes Optional (auto-filled from main)
 * - excludeFromCreation fields become Optional
 */
function buildSecondaryFields(
  joinSchema: SchemaDefinition,
  joinField: string,
  secondaryTableConf: ITable | undefined
): Record<string, TSchema> {
  const fields: Record<string, TSchema> = { ...joinSchema.fields };

  if (joinField in fields) {
    fields[joinField] = Type.Optional(fields[joinField]);
  }

  if (secondaryTableConf?.excludeFromCreation) {
    for (const field of secondaryTableConf.excludeFromCreation) {
      if (field in fields) {
        fields[field] = Type.Optional(fields[field]);
      }
    }
  }

  return fields;
}

/** `Nullable` marks a column with the type-array form; this reads that mark back. */
function admitsNull(schema: TSchema): boolean {
  const type = (schema as { type?: string | string[] }).type;
  return Array.isArray(type) && type.includes('null');
}

/** The same schema without the Optional modifier, i.e. as a required property. */
export function asRequired(schema: TSchema): TSchema {
  if (!(OptionalKind in schema)) return schema;
  return Type.Required(Type.Object({ value: schema })).properties.value;
}

/**
 * Apply schemaOverrides to a fields record: each matching field becomes the declared schema,
 * verbatim.
 *
 * Verbatim is the contract on the request side, where the schema is a validation rule the
 * consumer writes: an override without `Type.Optional` makes the field mandatory and one
 * without `Nullable` rejects an explicit `null`, whatever the column allows. That is how a
 * column the DB had to make nullable — a new column on a populated table — is made mandatory
 * from this release on. Write the modifiers when you want them.
 *
 * Response schemas are the exception and go through `readableResponseFields`: there is no
 * validation on the way out, only serialization, so a declaration cannot reject a value — it
 * can only misrepresent one.
 *
 * Replace-only: an override naming a field the table does not have is ignored, so the
 * declaration can never introduce a property the engine will not produce.
 */
export function applySchemaOverrides(
  fields: Record<string, TSchema>,
  tableConf: ITable | undefined
): Record<string, TSchema> {
  if (!tableConf?.schemaOverrides) return fields;
  const result = { ...fields };
  for (const [field, schema] of Object.entries(tableConf.schemaOverrides)) {
    if (field in result && schema) {
      result[field] = schema;
    }
  }
  return result;
}

type JoinFieldsBuilder = (
  join: JoinDefinition,
  secondaryConf: ITable | undefined
) => Record<string, TSchema>;

/**
 * Maps each writeJoin alias to a Type.Array(Type.Object(...)) using the provided fields builder.
 * When `itemsPartial` is true, wraps each item with Type.Partial — used for deletion sub-schemas
 * where every field is a matcher (the engine auto-injects the FK to main).
 */
function buildJoinAliasMap(
  tableConf: ITable,
  dbTables: DbTables,
  build: JoinFieldsBuilder,
  options: { itemsPartial?: boolean; strictItems?: boolean } = {}
): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  if (!tableConf.allowedWriteJoins?.length) return out;
  const objOpts = options.strictItems ? { additionalProperties: false } : {};
  for (const j of tableConf.allowedWriteJoins) {
    const sc = findSecondaryTableConf(dbTables, j.joinSchema.tableName);
    const item = Type.Object(build(j, sc), objOpts);
    out[j.alias] = Type.Array(options.itemsPartial ? Type.Partial(item) : item);
  }
  return out;
}

/**
 * Attach `secondaries` (and optionally `deletions`) sections to the given target object,
 * iterating once over `tableConf.allowedWriteJoins`. Mutates `target` in-place.
 * Used by body and response schema builders for insert/update/bulk-upsert.
 *
 * Deletions are emitted with every field Optional (Type.Partial) because the engine
 * auto-injects the FK to main and the consumer typically just provides the PK (or a small
 * subset of fields) to identify which child rows to delete.
 */
export function attachWriteJoinSections(
  target: Record<string, TSchema>,
  tableConf: ITable,
  dbTables: DbTables,
  options: { withDeletions: boolean; secondaryFields: JoinFieldsBuilder; strictItems?: boolean }
): void {
  if (!tableConf.allowedWriteJoins?.length) return;

  // additionalProperties:false closes the alias container itself, not just the items: an alias
  // the table does not declare must be a validation error, never a key that reaches the engine.
  const aliasMap = { additionalProperties: false };

  target.secondaries = Type.Optional(
    Type.Partial(
      Type.Object(
        buildJoinAliasMap(tableConf, dbTables, options.secondaryFields, { strictItems: options.strictItems }),
        aliasMap
      )
    )
  );
  if (options.withDeletions) {
    target.deletions = Type.Optional(
      Type.Partial(
        Type.Object(
          buildJoinAliasMap(
            tableConf,
            dbTables,
            ({ joinSchema }) => joinSchema.fields,
            { itemsPartial: true },
          ),
          aliasMap
        )
      )
    );
  }
}

/** JoinFieldsBuilder for body schemas: includes all join fields with FK + excluded made Optional. */
export const writeJoinBodyFields: JoinFieldsBuilder = (j, sc) =>
  buildSecondaryFields(j.joinSchema, j.joinField, sc);

/** JoinFieldsBuilder for response schemas: PK only. */
export const writeJoinResponseFields: JoinFieldsBuilder = (j, sc) =>
  pkSchema(sc, j.joinSchema, j.joinField);

/** Schema fields minus the ones hidden by `readExclude`. */
export function readableFields(
  schema: SchemaDefinition,
  tableConf: ITable | undefined
): Record<string, TSchema> {
  if (!tableConf?.readExclude?.length) return { ...schema.fields };
  const out: Record<string, TSchema> = {};
  for (const field of readableFieldNames(tableConf, schema)) {
    out[field] = schema.fields[field];
  }
  return out;
}

/**
 * The shape of one record as a read returns it: readable fields, narrowed by
 * `schemaOverrides`, with the column's nullability kept.
 *
 * The overrides belong here as much as on the write bodies — a narrowing describes the field,
 * not the direction it travels, and a response documented on the raw introspected type
 * promises something looser than the API returns.
 *
 * Nullability is where the two directions part. On the way in an override is a rule and a
 * non-nullable declaration *rejects* `null`. On the way out nothing is validated: Fastify
 * serializes against the schema, so a `string` declaration facing a stored `NULL` does not
 * refuse it — `fast-json-stringify` writes `""`. A column that can hold `NULL` therefore keeps
 * `null` in its response type, no matter how the override was written. An override that spells
 * `Nullable(...)` out itself is already there and is left alone.
 */
export function readableResponseFields(
  schema: SchemaDefinition,
  tableConf: ITable | undefined
): Record<string, TSchema> {
  const original = readableFields(schema, tableConf);
  const narrowed = applySchemaOverrides(original, tableConf);
  if (narrowed === original) return original;

  const out: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(narrowed)) {
    out[key] = admitsNull(original[key]) && !admitsNull(value) ? Nullable(value) : value;
  }
  return out;
}
