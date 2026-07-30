import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { ALLOWED_METHODS } from '../condition-methods.js';
import { readableFieldNames } from '../read-access.js';
import { DEFAULT_MAX_ITEMS_PER_PAGE } from '../../types.js';
import type { DbTables, ITable, SchemaDefinition } from '../../types.js';

/** Schema fields minus the ones hidden by `readExclude`. */
function readableFields(
  schema: SchemaDefinition,
  tableConf: ITable | undefined
): Record<string, TSchema> {
  if (!tableConf?.readExclude?.length) return { ...schema.fields };
  const out: Record<string, TSchema> = {};
  for (const field of readableFieldNames(tableConf, schema)) {
    out[field] = schema.fields[field];
  }
  return out;
}

/**
 * A `filters` map.
 *
 * Deliberately NOT `additionalProperties: false`, unlike the write bodies. Fastify runs Ajv
 * with `removeAdditional: true`, so a closed schema would silently *strip* an unknown filter
 * key before the handler ever sees it — reproducing the very bug it looks like it fixes, and
 * leaving the engine's rejection unreachable over HTTP. Unknown keys are rejected by
 * `assertKnownFilterKeys` in the engine instead, which also covers `sqlApi.search()`.
 */
function filtersObject(fields: Record<string, TSchema>): TObject {
  return Type.Partial(Type.Object(fields));
}

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

  // Build a TypeBox map of computed-field types (declared in defineTable).
  const computedTypes: Record<string, TSchema> = {};
  if (tableConf.computedFields) {
    for (const [name, fn] of Object.entries(tableConf.computedFields)) {
      // Cheap dry-run with a stub context to extract the declared `type`.
      // The fn is pure-functional w.r.t. ctx — only `type` is read here.
      try {
        const stub = fn({
          db: { qi: (s: string) => s, dialectName: 'postgres' } as never,
          qiCol: () => '""',
        });
        if (stub.type) computedTypes[name] = stub.type;
      } catch {
        // ignore — Swagger schema generation is best-effort; runtime validates.
      }
    }
  }

  const filterFields = {
    ...readableFields(schema, tableConf),
    ...tableConf.extraFilters,
    ...computedTypes,
  };
  const filtersSchema = Type.Optional(filtersObject(filterFields));

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

      const joinComputedTypes: Record<string, TSchema> = {};
      if (joinTableConf?.computedFields) {
        for (const [name, fn] of Object.entries(joinTableConf.computedFields)) {
          try {
            const stub = fn({
              db: { qi: (s: string) => s, dialectName: 'postgres' } as never,
              qiCol: () => '""',
            });
            if (stub.type) joinComputedTypes[name] = stub.type;
          } catch {
            // best-effort
          }
        }
      }

      const joinSchemaFields = joinTableConf
        ? { ...readableFields(joinSchema, joinTableConf), ...joinComputedTypes }
        : { ...joinSchema.fields };

      // `extraFilters` are only honoured where the engine delegates to the join table's
      // own `filters()` — buildJoinRefCondition, i.e. the unique:false paths. joinLeft
      // builds its condition inline (buildLeftJoinClauses) and handles schema and computed
      // fields only, so advertising extraFilters there would promise a silent no-op.
      const joinFilterFields = { ...joinSchemaFields, ...(joinTableConf?.extraFilters ?? {}) };

      const joinRefShape = {
        filters: Type.Optional(filtersObject(joinFilterFields)),
        conditions: Type.Optional(Type.Array(conditionItemSchema)),
      };

      if (unique) {
        joinLeftProps[alias] = Type.Object({
          filters: Type.Optional(filtersObject(joinSchemaFields)),
          conditions: Type.Optional(Type.Array(conditionItemSchema)),
          selection: Type.Optional(Type.String()),
        });
      } else {
        joinMustExistProps[alias] = Type.Object(joinRefShape);
        joinMultipleProps[alias] = Type.Object({
          ...joinRefShape,
          selection: Type.Optional(Type.String()),
        });
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
          filters: Type.Optional(filtersObject(joinFilterFields)),
          conditions: Type.Optional(Type.Array(conditionItemSchema)),
        });
      }
    }
  }

  const bodyProperties: Record<string, unknown> = {
    filters: filtersSchema,
    conditions: Type.Optional(Type.Array(conditionItemSchema)),
  };

  if (Object.keys(computedTypes).length > 0) {
    bodyProperties.selectComputed = Type.Optional(Type.Array(Type.String()));
  }

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

/**
 * Querystring schema, parameterized on the plugin's `maxItemsPerPage`.
 *
 * The `itemsPerPage` default MUST NOT exceed the cap: Ajv injects the default before any
 * runtime check runs, so a fixed default of 500 combined with `maxItemsPerPage: 100` would
 * make every request without an explicit `itemsPerPage` fail with 400. The default is
 * therefore `min(500, cap)` and the cap doubles as the schema `maximum` (structured 400).
 */
export function SearchTableQuery(maxItemsPerPage: number = DEFAULT_MAX_ITEMS_PER_PAGE): TObject {
  return Type.Object({
    orderBy: Type.Optional(Type.String()),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    itemsPerPage: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: maxItemsPerPage,
      default: Math.min(500, maxItemsPerPage),
    })),
    computeMin: Type.Optional(Type.String()),
    computeMax: Type.Optional(Type.String()),
    computeSum: Type.Optional(Type.String()),
    computeAvg: Type.Optional(Type.String()),
    // selectComputed list goes in the body (POST), not querystring — see SearchTableBodyPost.
  });
}

/** Default-cap variant, kept for granular composition and backward compatibility. */
export const SearchTableQueryString = SearchTableQuery();

export function SearchTableResponse(dbTables: DbTables, tableName: string): TObject {
  const tableConf = dbTables[tableName];

  // Computed fields are present in main rows only when explicitly listed in
  // request body's selectComputed, so they're optional/Partial here.
  const computedTypes: Record<string, TSchema> = {};
  if (tableConf.computedFields) {
    for (const [name, fn] of Object.entries(tableConf.computedFields)) {
      try {
        const stub = fn({
          db: { qi: (s: string) => s, dialectName: 'postgres' } as never,
          qiCol: () => '""',
        });
        if (stub.type) computedTypes[name] = stub.type;
      } catch {
        // best-effort
      }
    }
  }

  const mainReadable = readableFields(tableConf.Schema, tableConf);
  const mainItem = Object.keys(computedTypes).length > 0
    ? Type.Partial(Type.Object({ ...mainReadable, ...computedTypes }))
    : Type.Partial(Type.Object(mainReadable));

  const joinMultipleProps: Record<string, ReturnType<typeof Type.Array>> = {};
  const joinLeftProps: Record<string, ReturnType<typeof Type.Array>> = {};
  const joinGroupProps: Record<string, TSchema> = {};

  if (tableConf.allowedReadJoins) {
    for (const joinDef of tableConf.allowedReadJoins) {
      const { joinSchema, alias, unique } = joinDef;
      const itemArray = Type.Array(
        Type.Partial(Type.Object(readableFields(joinSchema, dbTables[joinSchema.tableName])))
      );
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
