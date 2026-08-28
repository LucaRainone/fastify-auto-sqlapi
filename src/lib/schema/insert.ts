import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { writableFields } from '../write-access.js';
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

  // Main: full validation, but excludeFromCreation fields become Optional. Fields the
  // database computes are not offered at all — sending one is rejected here (400) rather
  // than by the driver (500).
  const mainFields: Record<string, TSchema> = writableFields(
    applySchemaOverrides({ ...schema.fields }, tableConf),
    tableConf,
    schema
  );
  if (tableConf.excludeFromCreation) {
    for (const field of tableConf.excludeFromCreation) {
      if (field in mainFields) mainFields[field] = Type.Optional(mainFields[field]);
    }
  }

  const bodyProperties: Record<string, TSchema> = {
    // additionalProperties:false makes the schema the real write whitelist — unknown keys are
    // rejected (400) instead of silently reaching the INSERT as columns (mass assignment).
    main: Type.Object(mainFields, { additionalProperties: false }),
  };

  attachWriteJoinSections(bodyProperties, tableConf, dbTables, {
    withDeletions: false,
    secondaryFields: writeJoinBodyFields,
    strictItems: true,
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
