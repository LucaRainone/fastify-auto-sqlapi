import { Type, type TSchema } from 'typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { writableFields } from '../write-access.js';
import {
  pkSchema,
  applySchemaOverrides,
  attachRequestSections,
  attachOutcomeSections,
  WriteActionSchema,
} from './helpers.js';

export function BulkUpsertTableBody(dbTables: DbTables, tableName: string, maxItems?: number) {
  const tableConf = dbTables[tableName];
  const schema = tableConf.schema;

  // additionalProperties:false makes the schema the real write whitelist (no mass assignment).
  // It goes on Partial itself: Partial rebuilds the object and drops the source's options.
  const mainSchema = Type.Partial(
    Type.Object(writableFields(applySchemaOverrides({ ...schema.fields }, tableConf), tableConf, schema)),
    { additionalProperties: false }
  );

  const itemProperties: Record<string, TSchema> = {
    main: mainSchema,
  };

  attachRequestSections(itemProperties, tableConf, dbTables, { withDelete: true });

  return Type.Array(Type.Object(itemProperties), maxItems != null ? { maxItems } : {});
}

export function BulkUpsertTableResponse(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.schema, primaryAsString(tableConf.primary))),
    action: WriteActionSchema,
  };

  attachOutcomeSections(responseProperties, tableConf, dbTables, { deletions: 'all' });

  return Type.Array(Type.Object(responseProperties));
}
