import { Type, type TObject, type TSchema } from 'typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { writableFields, insertExcludedFields } from '../write-access.js';
import {
  pkSchema,
  applySchemaOverrides,
  attachRequestSections,
  attachOutcomeSections,
  relaxTenantColumns,
  WriteActionSchema,
} from './helpers.js';

export function InsertTableBody(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.schema;

  // Main: full validation, but insertExclude fields become Optional. Fields the
  // database computes are not offered at all — sending one is rejected here (400) rather
  // than by the driver (500).
  const mainFields: Record<string, TSchema> = writableFields(
    applySchemaOverrides({ ...schema.fields }, tableConf),
    tableConf,
    schema
  );
  for (const field of insertExcludedFields(tableConf)) {
    if (field in mainFields) mainFields[field] = Type.Optional(mainFields[field]);
  }
  // The tenant column is the engine's to fill or check, never the client's to be forced to send.
  relaxTenantColumns(mainFields, tableConf, schema);

  const bodyProperties: Record<string, TSchema> = {
    // additionalProperties:false makes the schema the real write whitelist — unknown keys are
    // rejected (400) instead of silently reaching the INSERT as columns (mass assignment).
    main: Type.Object(mainFields, { additionalProperties: false }),
  };

  attachRequestSections(bodyProperties, tableConf, dbTables, { withDelete: false });

  return Type.Object(bodyProperties);
}

export function InsertTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.schema, primaryAsString(tableConf.primary))),
    action: WriteActionSchema,
  };

  attachOutcomeSections(responseProperties, tableConf, dbTables, { deletions: 'replaced' });

  return Type.Object(responseProperties);
}
