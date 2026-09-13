import { toCamelCase, toSchemaName } from '../naming.js';
import type { ColumnInfo, TableMap } from '../../types.js';

/** Maps a DB column type to its TypeBox schema expression.
 * @testonly Exported only so unit tests can exercise it directly.
 */
export function convertColType(
  udtName: string,
  columnInfo: {
    column_default: string | null;
    is_nullable: string;
    is_auto_increment?: boolean;
    is_generated?: boolean;
  }
): string {
  // AUTO_INCREMENT (mysql) and IDENTITY (postgres) behave like a default: the DB generates
  // the value. A generated column goes further — it refuses one — so it can never be a
  // mandatory field either, whatever its nullability says.
  const hasDefault =
    columnInfo.column_default || columnInfo.is_auto_increment || columnInfo.is_generated;
  const isNullable = columnInfo.is_nullable === 'YES';

  const wrap = (t: string): string => {
    // Nullable columns need the type-array form (`Nullable(T)` → type: [..., 'null']):
    // Type.Optional alone means "key may be absent", and serializing a NULL value against
    // a plain type coerces it (0 / "" / false). A Type.Union with Null is no better —
    // Ajv's coerceTypes corrupts null/0/"" through the union branches.
    if (isNullable) t = `Nullable(${t})`;
    return hasDefault || isNullable ? `Type.Optional(${t})` : t;
  };

  switch (udtName) {
    case 'uuid':
      return wrap("Type.String({format: 'uuid'})");
    case 'bool':
      return wrap('Type.Boolean()');
    case 'float4':
    case 'float8':
    case 'numeric':
      return wrap('Type.Number()');
    case 'int2':
    case 'int4':
    case 'int8':
      return wrap('Type.Integer()');
    case 'varchar':
    case 'text':
    case 'char':
    case 'bpchar':
      return wrap('Type.String()');
    case 'timestamptz':
    case 'timestamp':
      return wrap('Type.String()');
    case 'date':
      return wrap("Type.String({format: 'date'})");
    case 'time':
      return wrap('Type.String()');
    case 'jsonb':
    case 'json':
      return wrap('Type.Any()');
    case '_varchar':
    case '_text':
      return wrap('Type.Array(Type.String())');
    case '_int2':
    case '_int4':
    case '_int8':
      return wrap('Type.Array(Type.Integer())');
    case '_float4':
    case '_float8':
      return wrap('Type.Array(Type.Number())');
    default:
      if (udtName.substring(0, 3) === 'int') {
        return wrap('Type.Integer()');
      }
      return wrap('Type.String()');
  }
}

export function buildTableMap(rows: ColumnInfo[]): TableMap {
  return rows.reduce<TableMap>((acc, row) => {
    const schemaName = toSchemaName(row.table_name);

    if (!acc[schemaName]) {
      acc[schemaName] = {
        name: row.table_name,
        fields: {},
        colMap: {},
        primary: [],
        generated: [],
        isView: row.is_view === true,
      };
    }

    const fieldName = toCamelCase(row.column_name);

    // Two columns mapping to the same camelCase field (e.g. user_name + userName) would
    // silently overwrite each other in the colMap, dropping one column from the API.
    const existing = acc[schemaName].colMap[fieldName];
    if (existing !== undefined && existing !== row.column_name) {
      throw new Error(
        `Naming collision on table "${row.table_name}": columns "${existing}" and ` +
        `"${row.column_name}" both map to the API field "${fieldName}". ` +
        `Rename one of the columns (or exclude the table) before generating schemas.`
      );
    }

    acc[schemaName].fields[fieldName] = convertColType(
      row.udt_name,
      row
    );
    acc[schemaName].colMap[fieldName] = row.column_name;
    if (row.is_primary) {
      acc[schemaName].primary.push(fieldName);
    }
    if (row.is_generated) {
      acc[schemaName].generated.push(fieldName);
    }

    return acc;
  }, {});
}

/** Compile a config glob — `*` is the only wildcard, everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`);
}

function assertPatternList(option: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string')) {
    throw new Error(`Invalid config: "${option}" must be an array of strings.`);
  }
}

/**
 * Remove from `tableMap` the tables matching any of the `excludeTables` config patterns.
 * Patterns are matched against the DB table name (not the generated schema name);
 * `*` is the only wildcard — everything else is literal.
 * Returns the names of the excluded tables, in map order.
 */
export function applyExcludeTables(tableMap: TableMap, excludeTables?: string[]): string[] {
  if (excludeTables === undefined) return [];
  assertPatternList('excludeTables', excludeTables);
  if (excludeTables.length === 0) return [];

  const regexes = excludeTables.map(globToRegExp);

  const excluded: string[] = [];
  for (const schemaName of Object.keys(tableMap)) {
    const tableName = tableMap[schemaName].name;
    if (regexes.some((re) => re.test(tableName))) {
      excluded.push(tableName);
      delete tableMap[schemaName];
    }
  }
  return excluded;
}

/**
 * Remove from every table in `tableMap` the columns matching any of the `excludeColumns`
 * config patterns. A pattern is `<table>.<column>`, both parts matched against the DB names
 * (not the generated field names) with `*` as the only wildcard on either side.
 *
 * An excluded column does not exist for the API at all: it leaves the Schema's fields, its
 * `colMap` and its `generatedFields`, so every read, write, filter and manifest built from the
 * Schema is unaware of it. That is also why the primary key is refused — every engine
 * identifies rows with it — and why a table that would end up empty is refused too: that
 * is `excludeTables`' job.
 *
 * Returns the excluded columns as `table.column`, in map order.
 */
export function applyExcludeColumns(tableMap: TableMap, excludeColumns?: string[]): string[] {
  if (excludeColumns === undefined) return [];
  assertPatternList('excludeColumns', excludeColumns);
  if (excludeColumns.length === 0) return [];

  const matchers = excludeColumns.map((pattern) => {
    const dot = pattern.indexOf('.');
    if (dot <= 0 || dot === pattern.length - 1) {
      throw new Error(
        `Invalid config: excludeColumns entry "${pattern}" must be in the form "table.column" ` +
        `(a "*" wildcard is allowed on either side, e.g. "*.password_hash").`
      );
    }
    return {
      table: globToRegExp(pattern.slice(0, dot)),
      column: globToRegExp(pattern.slice(dot + 1)),
    };
  });

  const excluded: string[] = [];
  for (const schemaName of Object.keys(tableMap)) {
    const table = tableMap[schemaName];
    const tableMatchers = matchers.filter((m) => m.table.test(table.name));
    if (tableMatchers.length === 0) continue;

    for (const field of Object.keys(table.fields)) {
      const columnName = table.colMap[field];
      if (!tableMatchers.some((m) => m.column.test(columnName))) continue;

      if (table.primary.includes(field)) {
        throw new Error(
          `Invalid config: excludeColumns cannot exclude the primary key column ` +
          `"${table.name}.${columnName}" — every route identifies rows with it.`
        );
      }
      delete table.fields[field];
      delete table.colMap[field];
      table.generated = table.generated.filter((f) => f !== field);
      excluded.push(`${table.name}.${columnName}`);
    }

    if (Object.keys(table.fields).length === 0) {
      throw new Error(
        `Invalid config: excludeColumns leaves table "${table.name}" with no columns. ` +
        `To hide a whole table use excludeTables instead.`
      );
    }
  }
  return excluded;
}

export function generateSchemaFile(
  schemaName: string,
  tableName: string,
  fields: Record<string, string>,
  colMap: Record<string, string>,
  primary?: string[],
  generated?: string[],
  isView?: boolean
): string {
  const fieldsStr = JSON.stringify(fields, null, 2).replace(
    /"(.*?)"\s*:\s*"Type(.*?)"/g,
    '$1: Type$2'
  );

  const colMapStr = JSON.stringify(colMap, null, 2);
  const primaryKeyLine = primary?.length ? `\n  primaryKey: ${JSON.stringify(primary)},` : '';
  // Published so the table generator — and the runtime — know which columns the database
  // computes: those are readable but reject every write.
  const generatedLine = generated?.length ? `\n  generatedFields: ${JSON.stringify(generated)},` : '';
  // A view has no PRIMARY KEY constraint to introspect, so the table generator has to be told
  // it may not read the absence of one as "no key exists on this data".
  const isViewLine = isView ? `\n  isView: true,` : '';
  const usesNullable = Object.values(fields).some((t) => t.includes('Nullable('));
  const valueImports = usesNullable ? 'Type, Nullable' : 'Type';

  return `// Auto-generated by fastify-auto-sqlapi. Do not edit.
import { ${valueImports} } from "fastify-auto-sqlapi";
import type { Static } from "fastify-auto-sqlapi";

const _Schema = ${fieldsStr};

const _colMap: Record<string, string> = ${colMapStr};

const validation = Type.Object(_Schema, { $id: "${schemaName}" });
const partialValidation = Type.Object(
  Object.fromEntries(
    Object.entries(_Schema).map(([k, v]) => [
      k,
      (validation.required as string[] | undefined)?.includes(k) ? Type.Optional(v) : v,
    ])
  ),
  { additionalProperties: false, $id: "Partial${schemaName}" }
);

export const Schema = {
  col: (f: keyof typeof _Schema) => _colMap[f as string] ?? f,
  colMap: _colMap,
  fields: _Schema,
  validation,
  tableName: "${tableName}",
  partialValidation,${primaryKeyLine}${generatedLine}${isViewLine}
};
export const ${schemaName} = Schema;
export type TypeSchema = Static<typeof Schema.validation>;
export type Type${schemaName} = TypeSchema;
export default async function (fastify: any) {
  fastify.addSchema(partialValidation);
  fastify.addSchema(validation);
}
`;
}
