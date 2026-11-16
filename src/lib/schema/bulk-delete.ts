import { Type, type TSchema } from 'typebox';
import type { DbTables } from '../../types.js';
import { asRequired, pkSchema } from './helpers.js';

/**
 * `{ ids: [...] }`: the primary keys to delete, the same body for every table whatever its PK is
 * called. A single-column key takes the values, typed as the PK field; a composite key takes one
 * object per row naming every key field and nothing else (`{ postId: 1, tagId: 2 }`), so no id
 * can match on one column alone. `maxItems` (the plugin's `maxBulkItems`) caps the ids.
 */
export function BulkDeleteTableBody(dbTables: DbTables, tableName: string, maxItems?: number) {
  const tableConf = dbTables[tableName];
  const pkFields = Array.isArray(tableConf.primary) ? tableConf.primary : [tableConf.primary];
  const typeOf = (f: string): TSchema => asRequired(tableConf.schema.fields[f] ?? Type.String());
  const id = pkFields.length === 1
    ? typeOf(pkFields[0])
    : Type.Object(Object.fromEntries(pkFields.map((f) => [f, typeOf(f)])), { additionalProperties: false });

  return Type.Object({
    ids: Type.Array(id, maxItems != null ? { maxItems } : {}),
  }, { additionalProperties: false });
}

/** One `{ main: <key> }` per deleted row, the key naming every primary key field. */
export function BulkDeleteTableResponse(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];
  return Type.Array(
    Type.Object({
      main: Type.Object(pkSchema(tableConf, tableConf.schema, '')),
    })
  );
}
