import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { DbTables } from '../../types.js';
import { findSecondaryTableConf } from '../engine/write-helpers.js';

export function UpdateTableBody(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Main: PK required, all other fields optional
  const mainFields: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(schema.fields) as [string, TSchema][]) {
    mainFields[key] = key === tableConf.primary ? value : Type.Optional(value);
  }

  const bodyProperties: Record<string, TSchema> = {
    main: Type.Object(mainFields),
  };

  if (tableConf.allowedWriteJoins?.length) {
    // Secondaries: same as insert (FK + excludeFromCreation optional)
    const secondaryProperties: Record<string, TSchema> = {};
    // Deletions: partial fields to identify records to delete
    const deletionProperties: Record<string, TSchema> = {};

    for (const [joinSchema, joinField] of tableConf.allowedWriteJoins) {
      const joinTableName = joinSchema.tableName;
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinTableName);

      // Secondaries schema
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

      // Deletions schema: partial fields (identify by PK or any fields)
      deletionProperties[joinTableName] = Type.Array(
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
  const pkField = tableConf.primary;
  const pkType = tableConf.Schema.fields[pkField];

  // Main: PK-only response
  const responseProperties: Record<string, TSchema> = {
    main: Type.Object({ [pkField]: pkType }),
  };

  if (tableConf.allowedWriteJoins?.length) {
    const secondaryProperties: Record<string, TSchema> = {};
    const deletionProperties: Record<string, TSchema> = {};

    for (const [joinSchema] of tableConf.allowedWriteJoins) {
      const secondaryTableConf = Object.values(dbTables).find(
        (c) => c.Schema.tableName === joinSchema.tableName
      );
      const secPkField = secondaryTableConf?.primary || 'id';
      const secPkType = joinSchema.fields[secPkField] || Type.Any();
      const pkOnlySchema = Type.Object({ [secPkField]: secPkType });
      secondaryProperties[joinSchema.tableName] = Type.Array(pkOnlySchema);
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
