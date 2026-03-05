import { Type, type TSchema } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { DbTables, ITable, SchemaDefinition } from '../../types.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';

function pkSchema(tableConf: ITable | undefined, schema: SchemaDefinition, fallback: string): Record<string, TSchema> {
  const pk = tableConf?.primary || fallback;
  const fields = Array.isArray(pk) ? pk : [pk];
  const result: Record<string, TSchema> = {};
  for (const f of fields) {
    result[f] = schema.fields[f] || Type.Any();
  }
  return result;
}

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

  // Main: PK-only response
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
