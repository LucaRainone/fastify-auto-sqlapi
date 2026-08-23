import { Type, type TObject } from '@sinclair/typebox';
import { readableFields } from './helpers.js';
import type { DbTables } from '../../types.js';

/**
 * Response shape of `GET /rest/:table/:id`.
 *
 * Lives here rather than inline in the route so it is built from the same pieces as every
 * other operation: it drifted while it was inline, documenting `readExclude`d fields the
 * engine never selects.
 *
 * `Partial` because a record is returned column by column: a nullable column the driver
 * reports as absent must not fail serialization.
 */
export function GetTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  return Type.Object({
    main: Type.Partial(Type.Object(readableFields(tableConf.Schema, tableConf))),
  });
}
