import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import {
  pkSchema,
  applySchemaOverrides,
  attachWriteJoinSections,
  writeJoinBodyFields,
  writeJoinResponseFields,
} from './helpers.js';

export function InsertTableBody(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Main: full validation, but excludeFromCreation fields become Optional
  const mainFields: Record<string, TSchema> = applySchemaOverrides({ ...schema.fields }, tableConf);
  if (tableConf.excludeFromCreation) {
    for (const field of tableConf.excludeFromCreation) {
      mainFields[field] = Type.Optional(mainFields[field]);
    }
  }

  const bodyProperties: Record<string, TSchema> = {
    main: Type.Object(mainFields),
  };

  attachWriteJoinSections(bodyProperties, tableConf, dbTables, {
    withDeletions: false,
    secondaryFields: writeJoinBodyFields,
  });

  return Type.Object(bodyProperties);
}

export function InsertTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.Schema, primaryAsString(tableConf.primary))),
  };

  attachWriteJoinSections(responseProperties, tableConf, dbTables, {
    withDeletions: false,
    secondaryFields: writeJoinResponseFields,
  });

  return Type.Object(responseProperties);
}
