import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { DbTables } from '../../types.js';

const JoinGroupResultItem = Type.Object({
  sum: Type.Optional(Type.Record(Type.String(), Type.Any())),
  min: Type.Optional(Type.Record(Type.String(), Type.Any())),
  max: Type.Optional(Type.Record(Type.String(), Type.Any())),
  distinctCount: Type.Optional(Type.Record(Type.String(), Type.Any())),
  rows: Type.Optional(Type.Array(Type.Any())),
});

export function SearchTableBodyPost(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  // Filters: schema fields + extraFilters
  const filterFields = {
    ...schema.fields,
    ...tableConf.extraFilters,
  };
  const filtersSchema = Type.Optional(Type.Partial(Type.Object(filterFields)));

  // Joins & JoinGroups from allowedReadJoins
  const joinProperties: Record<string, ReturnType<typeof Type.Object>> = {};
  const joinFilterProperties: Record<string, ReturnType<typeof Type.Partial>> = {};
  const joinGroupProperties: Record<string, ReturnType<typeof Type.Object>> = {};

  if (tableConf.allowedReadJoins) {
    for (const [joinSchema] of tableConf.allowedReadJoins) {
      const joinTableName = joinSchema.tableName;
      const joinTableConf = dbTables[joinTableName];

      const joinFilterFields = joinTableConf
        ? { ...joinSchema.fields, ...joinTableConf.extraFilters }
        : { ...joinSchema.fields };

      joinProperties[joinTableName] = Type.Object({
        filters: Type.Optional(Type.Partial(Type.Object(joinFilterFields))),
      });

      joinFilterProperties[joinTableName] = Type.Partial(Type.Object(joinFilterFields));

      joinGroupProperties[joinTableName] = Type.Object({
        aggregations: Type.Object({
          by: Type.Optional(Type.String()),
          distinctCount: Type.Optional(Type.Array(Type.String())),
          min: Type.Optional(Type.Array(Type.String())),
          max: Type.Optional(Type.Array(Type.String())),
          sum: Type.Optional(Type.Array(Type.String())),
        }),
        filters: Type.Optional(Type.Partial(Type.Object(joinFilterFields))),
      });
    }
  }

  // Conditions: advanced filters with ConditionBuilder methods
  const conditionItemSchema = Type.Object({
    field: Type.String(),
    method: Type.String(),
    params: Type.Optional(Type.Array(Type.Any())),
  });

  const bodyProperties: Record<string, unknown> = {
    filters: filtersSchema,
    conditions: Type.Optional(Type.Array(conditionItemSchema)),
  };

  if (Object.keys(joinProperties).length > 0) {
    bodyProperties.joinFilters = Type.Optional(Type.Partial(Type.Object(joinFilterProperties)));
    bodyProperties.joins = Type.Optional(Type.Partial(Type.Object(joinProperties)));
    bodyProperties.joinGroups = Type.Optional(Type.Partial(Type.Object(joinGroupProperties)));
  }

  return Type.Object(bodyProperties as Record<string, ReturnType<typeof Type.Optional>>);
}

export const SearchTableQueryString = Type.Object({
  orderBy: Type.Optional(Type.String()),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  itemsPerPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 500 })),
  computeMin: Type.Optional(Type.String()),
  computeMax: Type.Optional(Type.String()),
  computeSum: Type.Optional(Type.String()),
  computeAvg: Type.Optional(Type.String()),
});

export function SearchTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const mainItem = Type.Partial(Type.Object(tableConf.Schema.fields));

  const joinResponseProperties: Record<string, ReturnType<typeof Type.Array>> = {};
  const joinGroupResponseProperties: Record<string, TSchema> = {};
  if (tableConf.allowedReadJoins) {
    for (const [joinSchema] of tableConf.allowedReadJoins) {
      joinResponseProperties[joinSchema.tableName] = Type.Array(
        Type.Partial(Type.Object(joinSchema.fields))
      );
      joinGroupResponseProperties[joinSchema.tableName] = JoinGroupResultItem;
    }
  }

  return Type.Object({
    table: Type.String(),
    main: Type.Array(mainItem),
    joins: Type.Optional(Type.Partial(Type.Object(joinResponseProperties))),
    joinGroups: Type.Optional(Type.Partial(Type.Object(joinGroupResponseProperties))),
    pagination: Type.Optional(
      Type.Object({
        total: Type.Integer(),
        pages: Type.Integer(),
        computed: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        paginator: Type.Object({
          page: Type.Integer(),
          itemsPerPage: Type.Integer(),
        }),
      })
    ),
  });
}
