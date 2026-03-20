import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';
import { pkSchema, buildSecondaryFields } from './helpers.js';

export function InsertTableBody(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Main: full validation, but excludeFromCreation fields become Optional
  const mainFields: Record<string, TSchema> = { ...schema.fields };
  if (tableConf.excludeFromCreation) {
    for (const field of tableConf.excludeFromCreation) {
      mainFields[field] = Type.Optional(mainFields[field]);
    }
  }

  const bodyProperties: Record<string, TSchema> = {
    main: Type.Object(mainFields),
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinSchema.tableName);
      const joinFields = buildSecondaryFields(joinSchema, joinField, secondaryTableConf);
      secondaryProperties[joinSchema.tableName] = Type.Array(Type.Object(joinFields));
    }

    bodyProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
  }

  return Type.Object(bodyProperties);
}

export function InsertTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.Schema, primaryAsString(tableConf.primary))),
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinSchema.tableName);
      secondaryProperties[joinSchema.tableName] = Type.Array(
        Type.Object(pkSchema(secondaryTableConf, joinSchema, joinField))
      );
    }

    responseProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
  }

  return Type.Object(responseProperties);
}
