import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';
import { pkSchema, buildSecondaryFields } from './helpers.js';

export function UpdateTableBody(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Main: PK required, all other fields optional
  const mainFields: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(schema.fields) as [string, TSchema][]) {
    mainFields[key] = key === primaryAsString(tableConf.primary) ? value : Type.Optional(value);
  }

  const bodyProperties: Record<string, TSchema> = {
    main: Type.Object(mainFields),
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};
    const deletionProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinSchema.tableName);
      const joinFields = buildSecondaryFields(joinSchema, joinField, secondaryTableConf);
      secondaryProperties[joinSchema.tableName] = Type.Array(Type.Object(joinFields));

      deletionProperties[joinSchema.tableName] = Type.Array(
        Type.Partial(Type.Object(joinSchema.fields))
      );
    }

    bodyProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
    bodyProperties.deletions = Type.Optional(
      Type.Partial(Type.Object(deletionProperties))
    );
  }

  return Type.Object(bodyProperties);
}

export function UpdateTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.Schema, primaryAsString(tableConf.primary))),
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};
    const deletionProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinSchema.tableName);
      secondaryProperties[joinSchema.tableName] = Type.Array(
        Type.Object(pkSchema(secondaryTableConf, joinSchema, joinField))
      );
      deletionProperties[joinSchema.tableName] = Type.Array(
        Type.Partial(Type.Object(joinSchema.fields))
      );
    }

    responseProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
    responseProperties.deletions = Type.Optional(
      Type.Partial(Type.Object(deletionProperties))
    );
  }

  return Type.Object(responseProperties);
}
