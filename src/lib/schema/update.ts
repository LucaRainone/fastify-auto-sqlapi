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

export function UpdateTableBody(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Main: PK required, all other fields optional (overrides applied before Optional wrap)
  const baseFields = applySchemaOverrides({ ...schema.fields }, tableConf);
  const mainFields: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(baseFields) as [string, TSchema][]) {
    mainFields[key] = key === primaryAsString(tableConf.primary) ? value : Type.Optional(value);
  }

  const bodyProperties: Record<string, TSchema> = {
    // additionalProperties:false makes the schema the real write whitelist — unknown keys are
    // rejected (400) instead of silently reaching the UPDATE as columns (mass assignment).
    main: Type.Object(mainFields, { additionalProperties: false }),
  };

  attachWriteJoinSections(bodyProperties, tableConf, dbTables, {
    withDeletions: true,
    secondaryFields: writeJoinBodyFields,
    strictItems: true,
  });

  return Type.Object(bodyProperties);
}

export function UpdateTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.Schema, primaryAsString(tableConf.primary))),
  };

  attachWriteJoinSections(responseProperties, tableConf, dbTables, {
    withDeletions: true,
    secondaryFields: writeJoinResponseFields,
  });

  return Type.Object(responseProperties);
}
