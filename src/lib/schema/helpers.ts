import { Type, type TSchema } from '@sinclair/typebox';
import type { ITable, SchemaDefinition } from '../../types.js';

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
