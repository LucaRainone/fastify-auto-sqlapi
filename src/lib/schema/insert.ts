import { Type, type TObject, type TSchema } from '@sinclair/typebox';
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

  // Main: PK-only response
  const responseProperties: Record<string, TSchema> = {
    main: Type.Object(pkSchema(tableConf, tableConf.Schema, primaryAsString(tableConf.primary))),
  };

  // Secondaries response: PK-only
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
