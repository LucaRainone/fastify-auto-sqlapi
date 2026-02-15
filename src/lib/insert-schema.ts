import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { DbTables } from '../types.js';

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

  // Secondaries from allowedWriteJoins
  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const joinTableName = joinSchema.tableName;
      const joinFields: Record<string, TSchema> = { ...joinSchema.fields };

      // Make joinField Optional (auto-filled)
      if (joinField in joinFields) {
        joinFields[joinField] = Type.Optional(joinFields[joinField]);
      }

      // Find secondary tableConf for excludeFromCreation
      for (const [, conf] of Object.entries(dbTables)) {
        if (conf.Schema.tableName === joinTableName && conf.excludeFromCreation) {
          for (const field of conf.excludeFromCreation) {
            if (field in joinFields) {
              joinFields[field] = Type.Optional(joinFields[field]);
            }
          }
          break;
        }
      }

      secondaryProperties[joinTableName] = Type.Array(Type.Object(joinFields));
    }

    bodyProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
  }

  return Type.Object(bodyProperties);
}

export function InsertTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const mainItem = Type.Partial(Type.Object(tableConf.Schema.fields));

  const responseProperties: Record<string, TSchema> = {
    main: mainItem,
  };

  // Secondaries response
  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};

    for (const [joinSchema] of tableConf.allowedWriteJoins) {
      secondaryProperties[joinSchema.tableName] = Type.Array(
        Type.Partial(Type.Object(joinSchema.fields))
      );
    }

    responseProperties.secondaries = Type.Optional(
      Type.Partial(Type.Object(secondaryProperties))
    );
  }

  return Type.Object(responseProperties);
}
