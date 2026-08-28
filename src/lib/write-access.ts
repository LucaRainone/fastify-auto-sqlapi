import type { TSchema } from '@sinclair/typebox';
import type { ITable, SchemaDefinition } from '../types.js';

/**
 * Write visibility — the counterpart of `read-access.ts`.
 *
 * A field is excluded from writes for one of two reasons:
 *
 *  - the database computes it (`GENERATED ALWAYS AS (<expr>)`), which the generated Schema
 *    publishes in `generatedFields`. Naming such a column in an INSERT or an UPDATE is an
 *    error on both engines, whoever put the value there, so this exclusion is a fact about
 *    the column rather than a decision about the caller;
 *  - the table config lists it in `writeExclude`, for a column the deployment keeps read-only
 *    for reasons of its own.
 *
 * Excluded fields are removed from the write body schemas — so an HTTP caller gets a 400 from
 * `additionalProperties: false` rather than a driver error — and dropped again in the engines,
 * which `sqlApi.*` reaches without passing through those schemas.
 *
 * This is not `excludeFromCreation`, which whitelists CLIENT input on insert only and lets a
 * hook assign the field afterwards (ADR 0005); nor is it the place for per-caller field rules,
 * which stay in `beforeUpdate` / `validate` (ADR 0011).
 */
export function writeExcludedFields(
  tableConf: ITable | undefined,
  schema: SchemaDefinition | undefined
): Set<string> {
  const excluded = new Set<string>(schema?.generatedFields ?? []);
  for (const field of tableConf?.writeExclude ?? []) excluded.add(field);
  return excluded;
}

/** True when the table has nothing to exclude — lets callers keep their existing object. */
function hasWriteExclusions(
  tableConf: ITable | undefined,
  schema: SchemaDefinition | undefined
): boolean {
  return (schema?.generatedFields?.length ?? 0) > 0 || (tableConf?.writeExclude?.length ?? 0) > 0;
}

/**
 * A field map minus everything that may not be written. Used to build the write body schemas,
 * where the removal is what turns a rejected column into a 400 instead of a 500.
 */
export function writableFields(
  fields: Record<string, TSchema>,
  tableConf: ITable | undefined,
  schema: SchemaDefinition | undefined
): Record<string, TSchema> {
  if (!hasWriteExclusions(tableConf, schema)) return fields;
  const excluded = writeExcludedFields(tableConf, schema);
  const result: Record<string, TSchema> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!excluded.has(name)) result[name] = value;
  }
  return result;
}

/**
 * Drop the non-writable fields from a camelCase record, in place.
 *
 * Call this AFTER the write hooks, unlike `excludeFromCreation`: a hook cannot be allowed to
 * put back a value the database will refuse, so the last word has to belong to the exclusion.
 */
export function removeWriteExcluded(
  record: Record<string, unknown>,
  tableConf: ITable | undefined,
  schema: SchemaDefinition | undefined
): void {
  if (!hasWriteExclusions(tableConf, schema)) return;
  for (const field of writeExcludedFields(tableConf, schema)) {
    delete record[field];
  }
}
