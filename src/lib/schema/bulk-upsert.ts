import { Type, type TSchema } from '@sinclair/typebox';
import type { DbTables } from '../../types.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';

export function BulkUpsertTableBody(dbTables: DbTables, tableName: string) {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Main: all fields optional (upsert decides insert vs update)
  const mainSchema = Type.Partial(Type.Object(schema.fields));

  const itemProperties: Record<string, TSchema> = {
    main: mainSchema,
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};
    const deletionProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const joinTableName = joinSchema.tableName;
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinTableName);

      // Secondaries: FK + excludeFromCreation optional
      const joinFields: Record<string, TSchema> = { ...joinSchema.fields };
      if (joinField in joinFields) {
        joinFields[joinField] = Type.Optional(joinFields[joinField]);
      }
      if (secondaryTableConf?.excludeFromCreation) {
        for (const field of secondaryTableConf.excludeFromCreation) {
          if (field in joinFields) {
            joinFields[field] = Type.Optional(joinFields[field]);
          }
        }
      }
      secondaryProperties[joinTableName] = Type.Array(Type.Object(joinFields));

      // Deletions: partial fields
      deletionProperties[joinTableName] = Type.Array(
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
    main: Type.Partial(Type.Object(tableConf.Schema.fields)),
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};
    const deletionProperties: Record<string, TSchema> = {};

    for (const [joinSchema] of tableConf.allowedWriteJoins) {
      const partial = Type.Partial(Type.Object(joinSchema.fields));
      secondaryProperties[joinSchema.tableName] = Type.Array(partial);
      deletionProperties[joinSchema.tableName] = Type.Array(partial);
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
