import { Type, type TSchema } from '@sinclair/typebox';
import type { ITable, SchemaDefinition, DbTables, JoinDefinition } from '../../types.js';
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
export function buildSecondaryFields(
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

/**
 * Apply schemaOverrides to a fields record.
 * Replaces matching field schemas with the override.
 */
export function applySchemaOverrides(
  fields: Record<string, TSchema>,
  tableConf: ITable
): Record<string, TSchema> {
  if (!tableConf.schemaOverrides) return fields;
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

/** Maps each writeJoin alias to a Type.Array(Type.Object(...)) using the provided fields builder. */
export function buildJoinAliasMap(
  tableConf: ITable,
  dbTables: DbTables,
  build: JoinFieldsBuilder
): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  if (!tableConf.allowedWriteJoins?.length) return out;
  for (const j of tableConf.allowedWriteJoins) {
    const sc = findSecondaryTableConf(dbTables, j.joinSchema.tableName);
    out[j.alias] = Type.Array(Type.Object(build(j, sc)));
  }
  return out;
}

/**
 * Attach `secondaries` (and optionally `deletions`) sections to the given target object,
 * iterating once over `tableConf.allowedWriteJoins`. Mutates `target` in-place.
 * Used by body and response schema builders for insert/update/bulk-upsert.
 */
export function attachWriteJoinSections(
  target: Record<string, TSchema>,
  tableConf: ITable,
  dbTables: DbTables,
  options: { withDeletions: boolean; secondaryFields: JoinFieldsBuilder }
): void {
  if (!tableConf.allowedWriteJoins?.length) return;
  target.secondaries = Type.Optional(
    Type.Partial(Type.Object(buildJoinAliasMap(tableConf, dbTables, options.secondaryFields)))
  );
  if (options.withDeletions) {
    target.deletions = Type.Optional(
      Type.Partial(
        Type.Object(buildJoinAliasMap(tableConf, dbTables, ({ joinSchema }) => joinSchema.fields))
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
