import { Type, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import {
  pkSchema,
  applySchemaOverrides,
  attachWriteJoinSections,
  writeJoinBodyFields,
  writeJoinResponseFields,
} from './helpers.js';

export function BulkUpsertTableBody(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  const mainSchema = Type.Partial(Type.Object(applySchemaOverrides({ ...schema.fields }, tableConf)));

  const itemProperties: Record<string, TSchema> = {
    main: mainSchema,
  };

  attachWriteJoinSections(itemProperties, tableConf, dbTables, {
    withDeletions: true,
    secondaryFields: writeJoinBodyFields,
  });

  return Type.Array(Type.Object(itemProperties));
}

export function BulkUpsertTableResponse(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.Schema, primaryAsString(tableConf.primary))),
  };

  attachWriteJoinSections(responseProperties, tableConf, dbTables, {
    withDeletions: true,
    secondaryFields: writeJoinResponseFields,
  });

  return Type.Array(Type.Object(responseProperties));
}
