import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { ALLOWED_METHODS } from '../condition-methods.js';
import type { DbTables } from '../../types.js';

const JoinGroupResultItem = Type.Object({
  sum: Type.Optional(Type.Record(Type.String(), Type.Any())),
  min: Type.Optional(Type.Record(Type.String(), Type.Any())),
  max: Type.Optional(Type.Record(Type.String(), Type.Any())),
  avg: Type.Optional(Type.Record(Type.String(), Type.Any())),
  count: Type.Optional(Type.Record(Type.String(), Type.Any())),
  distinctCount: Type.Optional(Type.Record(Type.String(), Type.Any())),
  rows: Type.Optional(Type.Array(Type.Any())),
});

export function SearchTableBodyPost(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];
  const schema = tableConf.Schema;

  const methodEnum = Type.Union(ALLOWED_METHODS.map((m) => Type.Literal(m)));
  const conditionItemSchema = Type.Object({
    field: Type.String(),
    method: methodEnum,
    params: Type.Optional(Type.Array(Type.Any())),
  });

  const filterFields = {
    ...schema.fields,
    ...tableConf.extraFilters,
  };
  const filtersSchema = Type.Optional(Type.Partial(Type.Object(filterFields)));

  // Per-alias entries split by unique flag:
  //  - unique:false → joinMustExist / joinMultiple / joinGroup
  //  - unique:true  → joinLeft
  const joinMustExistProps: Record<string, ReturnType<typeof Type.Object>> = {};
  const joinMultipleProps: Record<string, ReturnType<typeof Type.Object>> = {};
  const joinGroupProps: Record<string, ReturnType<typeof Type.Object>> = {};
  const joinLeftProps: Record<string, ReturnType<typeof Type.Object>> = {};

  if (tableConf.allowedReadJoins) {
    for (const joinDef of tableConf.allowedReadJoins) {
      const { joinSchema, alias, unique } = joinDef;
      const joinTableConf = dbTables[joinSchema.tableName];

      const joinFilterFields = joinTableConf
        ? { ...joinSchema.fields, ...joinTableConf.extraFilters }
        : { ...joinSchema.fields };

      const joinRefShape = {
        filters: Type.Optional(Type.Partial(Type.Object(joinFilterFields))),
        conditions: Type.Optional(Type.Array(conditionItemSchema)),
      };

      const joinFetchShape = {
        ...joinRefShape,
        selection: Type.Optional(Type.String()),
      };

      if (unique) {
        joinLeftProps[alias] = Type.Object(joinFetchShape);
      } else {
        joinMustExistProps[alias] = Type.Object(joinRefShape);
        joinMultipleProps[alias] = Type.Object(joinFetchShape);
        joinGroupProps[alias] = Type.Object({
          aggregations: Type.Object({
            by: Type.Optional(Type.String()),
            distinctCount: Type.Optional(Type.Array(Type.String())),
            min: Type.Optional(Type.Array(Type.String())),
            max: Type.Optional(Type.Array(Type.String())),
            sum: Type.Optional(Type.Array(Type.String())),
            avg: Type.Optional(Type.Array(Type.String())),
            count: Type.Optional(Type.Array(Type.String())),
          }),
          filters: Type.Optional(Type.Partial(Type.Object(joinFilterFields))),
          conditions: Type.Optional(Type.Array(conditionItemSchema)),
        });
      }
    }
  }

  const bodyProperties: Record<string, unknown> = {
    filters: filtersSchema,
    conditions: Type.Optional(Type.Array(conditionItemSchema)),
  };

  if (Object.keys(joinMustExistProps).length > 0) {
    bodyProperties.joinMustExist = Type.Optional(Type.Partial(Type.Object(joinMustExistProps)));
    bodyProperties.joinMultiple = Type.Optional(Type.Partial(Type.Object(joinMultipleProps)));
    bodyProperties.joinGroup = Type.Optional(Type.Partial(Type.Object(joinGroupProps)));
  }
  if (Object.keys(joinLeftProps).length > 0) {
    bodyProperties.joinLeft = Type.Optional(Type.Partial(Type.Object(joinLeftProps)));
  }

  return Type.Object(bodyProperties as Record<string, ReturnType<typeof Type.Optional>>);
}

export const SearchTableQueryString = Type.Object({
  orderBy: Type.Optional(Type.String()),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  itemsPerPage: Type.Optional(Type.Integer({ minimum: 1, default: 500 })),
  computeMin: Type.Optional(Type.String()),
  computeMax: Type.Optional(Type.String()),
  computeSum: Type.Optional(Type.String()),
  computeAvg: Type.Optional(Type.String()),
});

export function SearchTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  const mainItem = Type.Partial(Type.Object(tableConf.Schema.fields));

  const joinMultipleProps: Record<string, ReturnType<typeof Type.Array>> = {};
  const joinLeftProps: Record<string, ReturnType<typeof Type.Array>> = {};
  const joinGroupProps: Record<string, TSchema> = {};

  if (tableConf.allowedReadJoins) {
    for (const joinDef of tableConf.allowedReadJoins) {
      const { joinSchema, alias, unique } = joinDef;
      const itemArray = Type.Array(Type.Partial(Type.Object(joinSchema.fields)));
      if (unique) {
        joinLeftProps[alias] = itemArray;
      } else {
        joinMultipleProps[alias] = itemArray;
        joinGroupProps[alias] = JoinGroupResultItem;
      }
    }
  }

  const responseProps: Record<string, unknown> = {
    table: Type.String(),
    main: Type.Array(mainItem),
  };

  if (Object.keys(joinMultipleProps).length > 0) {
    responseProps.joinMultiple = Type.Optional(Type.Partial(Type.Object(joinMultipleProps)));
    responseProps.joinGroup = Type.Optional(Type.Partial(Type.Object(joinGroupProps)));
  }
  if (Object.keys(joinLeftProps).length > 0) {
    responseProps.joinLeft = Type.Optional(Type.Partial(Type.Object(joinLeftProps)));
  }

  responseProps.pagination = Type.Optional(
    Type.Object({
      total: Type.Integer(),
      pages: Type.Integer(),
      computed: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      paginator: Type.Object({
        page: Type.Integer(),
        itemsPerPage: Type.Integer(),
      }),
    })
  );

  return Type.Object(responseProps as Record<string, ReturnType<typeof Type.Optional>>);
}
