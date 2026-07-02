import { Type } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';

export function BulkDeleteTableBody(dbTables: DbTables, tableName: string, maxItems?: number) {
  const tableConf = dbTables[tableName];
  const pkField = primaryAsString(tableConf.primary);
  const pkType = tableConf.Schema.fields[pkField];

  return Type.Array(
    Type.Object({ [pkField]: pkType }, { additionalProperties: false }),
    maxItems != null ? { maxItems } : {}
  );
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
