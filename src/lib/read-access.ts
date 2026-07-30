import type { QueryClient } from './db.js';
import type { ITable, SchemaDefinition } from '../types.js';
import { httpError } from './errors.js';

/**
 * Read visibility (`ITable.readExclude`).
 *
 * Excluded fields are never projected by any read query and cannot be referenced
 * from filters, conditions, orderBy, aggregations or join selections: allowing a
 * field to be filtered while hiding it from the output would still leak its value
 * by bisection. Write paths (insert/update/upsert) are deliberately unaffected —
 * a field can be writable but never readable (e.g. a password hash).
 */

export function isReadExcluded(tableConf: ITable | undefined, field: string): boolean {
  return tableConf?.readExclude?.includes(field) ?? false;
}

/** Throws 400 when `field` is read-excluded on `tableConf`. */
export function assertReadable(tableConf: ITable | undefined, field: string): void {
  if (isReadExcluded(tableConf, field)) {
    throw httpError(400, `Field is not readable: ${field}`);
  }
}

/**
 * Throws 400 when a filter map targets a read-excluded field. Keys that are not
 * excluded pass through untouched (extraFilters and computed names included).
 */
export function assertFiltersReadable(
  filters: Record<string, unknown> | undefined,
  tableConf: ITable | undefined
): void {
  if (!filters || !tableConf?.readExclude?.length) return;
  for (const key of Object.keys(filters)) {
    assertReadable(tableConf, key);
  }
}

/**
 * Throws 400 when a filter map carries a key the engine would never visit.
 *
 * Filters are matched against the schema fields, the table's `extraFilters` and its computed
 * fields; anything else used to be dropped without a word, so a mistyped key returned MORE
 * rows than the caller asked for and nothing said so. That is the dangerous direction to fail
 * in — filters are also how consumers narrow visibility — and it contradicted every
 * neighbouring path, where an unknown field in `selection`, `conditions`, `orderBy` or an
 * aggregation is already a 400.
 *
 * `schema` is the schema the relation was declared with, which for a join may be a trimmed
 * copy: a field outside it is unknown here exactly as it is for `selection`.
 *
 * `allowExtraFilters` is false on the joinLeft path, whose condition is built inline
 * (`buildLeftJoinClauses`) and never runs the table's `extendedCondition`.
 *
 * Call AFTER `assertFiltersReadable`, so a read-excluded field keeps its own message
 * instead of being reported as unknown.
 */
export function assertKnownFilterKeys(
  filters: Record<string, unknown> | undefined,
  schema: SchemaDefinition,
  tableConf: ITable | undefined,
  allowExtraFilters = true
): void {
  if (!filters) return;
  for (const [key, value] of Object.entries(filters)) {
    // `undefined` means "filter not supplied" everywhere else in the engine; an absent
    // filter cannot be a wrong one. `null` does filter (IS NULL) and is validated.
    if (value === undefined) continue;
    if (key in schema.fields) continue;
    if (tableConf?.computedFields?.[key]) continue;
    if (tableConf?.extraFilters && key in tableConf.extraFilters) {
      if (allowExtraFilters) continue;
      throw httpError(
        400,
        `Filter '${key}' is an extraFilter: extraFilters are not applied on joinLeft ` +
        `(only schema fields and computed fields are). Use joinMustExist on the same relation.`
      );
    }
    throw httpError(400, `Unknown filter field: ${key}`);
  }
}

/** Schema field names that may be read, in schema declaration order. */
export function readableFieldNames(
  tableConf: ITable | undefined,
  schema: SchemaDefinition
): string[] {
  const fields = Object.keys(schema.fields);
  if (!tableConf?.readExclude?.length) return fields;
  return fields.filter((f) => !isReadExcluded(tableConf, f));
}

/**
 * SELECT column list for a table with read exclusions, or `undefined` when the
 * table has none (callers keep their existing `*` projection).
 *
 * Columns are qualified with the table name: read queries may carry a tenant
 * `through` INNER JOIN, where a bare column name shared with the through table
 * would be ambiguous.
 */
export function readableSelectColumns(
  tableConf: ITable | undefined,
  schema: SchemaDefinition,
  db: QueryClient
): string | undefined {
  if (!tableConf?.readExclude?.length) return undefined;
  const table = db.qi(schema.tableName);
  return readableFieldNames(tableConf, schema)
    .map((f) => `${table}.${db.qi(schema.col(f))}`)
    .join(', ');
}
