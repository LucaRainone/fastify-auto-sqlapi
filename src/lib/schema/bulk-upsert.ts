import { Type, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables } from '../../types.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';
import { pkSchema, buildSecondaryFields } from './helpers.js';

export function BulkUpsertTableBody(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  const mainSchema = Type.Partial(Type.Object(schema.fields));

  const itemProperties: Record<string, TSchema> = {
    main: mainSchema,
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

    itemProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
    itemProperties.deletions = Type.Optional(
      Type.Partial(Type.Object(deletionProperties))
    );
  }

  return Type.Array(Type.Object(itemProperties));
}

export function BulkUpsertTableResponse(dbTables: DbTables, tableName: string) {
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

  return Type.Array(Type.Object(responseProperties));
}
