import { Type, type TSchema } from '@sinclair/typebox';
import type { ITable, SchemaDefinition, DbTables } from '../../types.js';

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
