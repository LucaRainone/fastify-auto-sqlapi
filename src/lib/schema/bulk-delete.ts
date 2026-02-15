import { Type } from '@sinclair/typebox';
import type { DbTables } from '../../types.js';

export function BulkDeleteTableBody(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];
  const pkField = tableConf.primary;
  const pkType = tableConf.Schema.fields[pkField];

  return Type.Array(Type.Object({ [pkField]: pkType }));
}

export function BulkDeleteTableResponse(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];

  return Type.Array(
    Type.Object({
      main: Type.Partial(Type.Object(tableConf.Schema.fields)),
    })
  );
}
