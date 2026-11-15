import { Type } from 'typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { asRequired } from './helpers.js';

/**
 * `{ ids: [...] }`: the primary key values to delete, typed as the PK field, the same body for
 * every table whatever its PK is called. `maxItems` (the plugin's `maxBulkItems`) caps the ids.
 */
export function BulkDeleteTableBody(dbTables: DbTables, tableName: string, maxItems?: number) {
  const tableConf = dbTables[tableName];
  const pkField = primaryAsString(tableConf.primary);
  const pkType = asRequired(tableConf.Schema.fields[pkField] ?? Type.String());

  return Type.Object({
    ids: Type.Array(pkType, maxItems != null ? { maxItems } : {}),
  }, { additionalProperties: false });
}

export function BulkDeleteTableResponse(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];
  const pkField = primaryAsString(tableConf.primary);
  const pkType = tableConf.Schema.fields[pkField];

  return Type.Array(
    Type.Object({
      main: Type.Object({ [pkField]: pkType }),
    })
  );
}
