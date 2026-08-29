import { ConditionBuilder, type ConditionValueOrUndefined, type DialectName as CbDialect } from 'node-condition-builder';
import { Type, type TSchema, type TObject } from '@sinclair/typebox';
import type {
  SchemaDefinition,
  JoinDefinition,
  TableFilterFn,
  ITable,
  TenantScopeIndirect,
} from '../types.js';
import { getDialect } from './dialect.js';
import { hasOwnField } from './read-access.js';

// Quote an identifier using the given ConditionBuilder dialect (or the global
// default when not provided). Needed so that DB columns with uppercase letters
// (e.g. betterauth "userId") are preserved on PostgreSQL (which folds unquoted
// identifiers to lowercase) and on MySQL (which is case-sensitive on Linux
// filesystems).
function qi(field: string, dialect?: CbDialect): string {
  return getDialect(dialect ?? ConditionBuilder.DIALECT).qi(field);
}

// Extract properties from TObject or use the Record directly
type ExtraProps<EF> = EF extends TObject<infer P> ? P : EF extends Record<string, TSchema> ? EF : Record<string, never>;

export function exportTableInfo<
  F extends Record<string, TSchema>,
  EF extends TObject | Record<string, TSchema> = Record<never, TSchema>,
>(
  Schema: SchemaDefinition<F>,
  extraFilters: EF = {} as EF,
  extendedCondition?: (
    condition: ConditionBuilder,
    filters: { [K in keyof F | keyof ExtraProps<EF>]?: ConditionValueOrUndefined }
  ) => void
): { Schema: SchemaDefinition<F>; filters: TableFilterFn; extraFilters: Record<string, TSchema> } {
  const filters: TableFilterFn = (filterValues, dialect, qualifier) => {
    const condition = new ConditionBuilder('AND', dialect);

    // Only auto-match real schema fields (DB columns). Columns are table-qualified:
    // the statement may carry joins (LEFT JOIN parents, tenant through-joins), and a
    // bare column shared with a joined table would be ambiguous. A caller-provided
    // qualifier (a subquery alias) takes precedence over the table name.
    const table = qi(qualifier ?? Schema.tableName, dialect);
    for (const field of Object.keys(Schema.fields)) {
      if (!(field in filterValues) || filterValues[field] === undefined) continue;
      const col = `${table}.${qi(Schema.col(field), dialect)}`;
      // An explicit null filters by IS NULL: equality with NULL never matches, and
      // silently dropping the filter would return unfiltered results for a request
      // that asked for "field is null".
      if (filterValues[field] === null) {
        // Second arg is CB's enable-guard: without `true` the call is a no-op.
        condition.isNull(col, true);
      } else {
        condition.isEqual(col, filterValues[field]);
      }
    }

    // extraFilters are handled exclusively by extendedCondition
    if (extendedCondition) {
      extendedCondition(condition, filterValues);
    }

    return condition;
  };

  // Extract properties from TObject or use as-is
  const efRecord: Record<string, TSchema> =
    (extraFilters && typeof extraFilters === 'object' && 'properties' in extraFilters)
      ? (extraFilters as TObject).properties
      : extraFilters;

  return { Schema, filters, extraFilters: efRecord };
}

export function defineTable<F extends Record<string, TSchema>>(
  config: ITable<F>
): ITable<F> {
  validateAliasUniqueness(config.allowedReadJoins, 'allowedReadJoins');
  validateAliasUniqueness(config.allowedWriteJoins, 'allowedWriteJoins');
  validateWriteJoinsUnrestricted(config.allowedWriteJoins);
  validateComputedFields(config as unknown as ITable);
  validatePrimary(config as unknown as ITable);
  validateReadExclude(config as unknown as ITable);
  validateWriteExclude(config as unknown as ITable);
  validateTenantScope(config as unknown as ITable);
  validateTenantColumnNames(config as unknown as ITable);
  return config;
}

/**
 * `tenantScope` has three forms and they do not mix: `{ column }`, `{ column, through }`, and
 * `{ anyOf }`. A config naming more than one form is ambiguous rather than additive — an `anyOf`
 * entry reached through a parent FK would need its own join per entry — and an empty `anyOf`
 * would fail closed on every row, which looks like a broken deployment rather than a rule.
 *
 * The columns it names are **real DB column names**, not camelCase schema fields — the one place
 * in `defineTable` where the convention flips. That is not an oversight: a scope is applied to
 * the SQL, after the payload has already been converted, and `through.foreignField` belongs to a
 * parent table that may have no config, no `colMap`, or no generated schema at all. It is the
 * same category as `db.*` and `extendedCondition`: names that go straight to the database.
 *
 * So existence cannot be checked — a hand-written schema may legitimately omit the column. What
 * *is* checked is the mistake that exception invites: naming the schema **field** whose real
 * column is something else. Left alone that surfaces as `column "organizationId" does not exist`
 * on every request to the table — an opaque 500 (ADR 0006), failing closed but saying nothing.
 */
/**
 * Reject a tenant column that is really a schema field name mapping to a different column.
 *
 * The check is deliberately narrow, and it self-adjusts: on a camelCase database `col()` is the
 * identity, so a camelCase name raises nothing. A name the schema does not carry raises nothing
 * either — that is the hand-written-schema case, and there is nothing to compare it against.
 */
function assertNamesColumn(
  schema: SchemaDefinition,
  name: string,
  where: string,
  table: string
): void {
  if (!hasOwnField(schema.fields, name)) return;
  const column = schema.col(name);
  if (column === name) return;

  throw new Error(
    `defineTable: tenantScope ${where} on table '${table}' names '${name}', which is a ` +
    `schema field, not a column: its column is '${column}'. tenantScope names real DB ` +
    `columns — the scope is applied to the SQL, after the payload has been converted — so ` +
    `write '${column}' here. Clients keep sending '${name}'.`
  );
}

function validateTenantScope(config: ITable): void {
  const scope = config.tenantScope;
  if (!scope) return;

  const table = config.Schema.tableName;
  const hasAnyOf = 'anyOf' in scope;
  const hasColumn = 'column' in scope;

  if (hasAnyOf && hasColumn) {
    throw new Error(
      `defineTable: tenantScope on table '${table}' declares both 'anyOf' and 'column'. ` +
      `Use one form: 'column' (owner column on this table), 'column' + 'through' (owner ` +
      `reached via a FK), or 'anyOf' (several owner columns, visible to any of them).`
    );
  }
  if (hasAnyOf && 'through' in scope) {
    throw new Error(
      `defineTable: tenantScope on table '${table}' combines 'anyOf' with 'through'. ` +
      `An 'anyOf' entry reached through a parent is not supported — declare the scope on ` +
      `the parent table instead.`
    );
  }

  if (hasAnyOf) {
    const { anyOf } = scope as { anyOf: unknown };
    if (!Array.isArray(anyOf) || !anyOf.length) {
      throw new Error(
        `defineTable: tenantScope 'anyOf' on table '${table}' must be a non-empty array of ` +
        `column names. An empty list would hide every row of the table.`
      );
    }
    if (anyOf.some((c) => typeof c !== 'string' || !c)) {
      throw new Error(
        `defineTable: tenantScope 'anyOf' on table '${table}' must contain column names as ` +
        `non-empty strings.`
      );
    }
    if (new Set(anyOf).size !== anyOf.length) {
      throw new Error(
        `defineTable: tenantScope 'anyOf' on table '${table}' repeats a column. ` +
        `Each owner column must appear once.`
      );
    }
    return;
  }

  if (!hasColumn || typeof (scope as { column: unknown }).column !== 'string') {
    throw new Error(
      `defineTable: tenantScope on table '${table}' declares neither 'column' nor 'anyOf'. ` +
      `A scope with no owner column would filter nothing.`
    );
  }
}

/**
 * Every column a scope names, checked against the schema it belongs to. Runs after
 * `validateTenantScope`, so the shape is already known to be one of the three valid forms.
 */
function validateTenantColumnNames(config: ITable): void {
  const scope = config.tenantScope;
  if (!scope) return;
  const table = config.Schema.tableName;

  if ('anyOf' in scope) {
    for (const entry of scope.anyOf) {
      assertNamesColumn(config.Schema, entry, "'anyOf'", table);
    }
    return;
  }

  const direct = scope as TenantScopeIndirect;
  assertNamesColumn(config.Schema, direct.column, "'column'", table);

  // `through.localField` is a column of THIS table; `through.foreignField` one of the parent's,
  // which is why the parent schema travels in the scope.
  const through = direct.through;
  if (!through || typeof through !== 'object') return;
  if (typeof through.localField === 'string') {
    assertNamesColumn(config.Schema, through.localField, "'through.localField'", table);
  }
  if (typeof through.foreignField === 'string' && typeof through.schema?.col === 'function') {
    assertNamesColumn(through.schema, through.foreignField, "'through.foreignField'", table);
  }
}

/**
 * `fields` narrows a relation for reading; it has no meaning on a write join and would be
 * actively harmful there. Write paths resolve the secondary's upsert rule by looking the
 * schema object up in `upsertMap` **by identity**, and a narrowed relation carries a copy —
 * the lookup would miss and the upsert would silently degrade to a plain insert. The
 * narrowed schema would also drop columns the caller legitimately sends.
 */
function validateWriteJoinsUnrestricted(joins: JoinDefinition[] | undefined): void {
  for (const join of joins ?? []) {
    if (join.fields) {
      throw new Error(
        `defineTable: relation '${join.alias}' in allowedWriteJoins declares 'fields'. ` +
        `The fields allowlist restricts reading only — remove it, and use a separate ` +
        `buildRelation for the read side if that relation is also in allowedReadJoins.`
      );
    }
  }
}

function validateReadExclude(config: ITable): void {
  const excluded = config.readExclude;
  if (!excluded?.length) return;

  const schemaFields = Object.keys(config.Schema.fields);
  const pkFields = Array.isArray(config.primary) ? config.primary : [config.primary];

  for (const field of excluded) {
    if (!schemaFields.includes(field)) {
      throw new Error(
        `defineTable: readExclude field '${field}' is not a schema field on ` +
        `table '${config.Schema.tableName}'.`
      );
    }
    if (pkFields.includes(field)) {
      throw new Error(
        `defineTable: readExclude cannot hide the primary key field '${field}' on ` +
        `table '${config.Schema.tableName}' — reads and joins rely on it.`
      );
    }
  }
}

/**
 * Every operation but `search` addresses a row by its primary key, and a `primary` naming a
 * field the schema does not have reaches the database as a column that may not exist — a raw
 * SQL error, so a 500 (ADR 0006), on the first request instead of at startup. Views are where
 * this bites: they carry no PRIMARY KEY constraint, so the generator writes a placeholder
 * rather than inventing a key that would silently address the wrong rows.
 *
 * `search` is the deliberate exception: it reads `primary` only as the fallback for ordering,
 * so a table that exposes nothing else and names its own `defaultOrder` never touches it. That
 * is exactly the shape the generator emits for a view whose key it could not infer, and it is
 * a working config — not a broken one waiting to be fixed.
 */
function validatePrimary(config: ITable): void {
  const schemaFields = Object.keys(config.Schema.fields);
  const pkFields = Array.isArray(config.primary) ? config.primary : [config.primary];
  const table = config.Schema.tableName;

  const missing = pkFields.filter((f) => !schemaFields.includes(f));
  if (missing.length === 0) return;

  const searchOnly = config.operations?.length === 1 && config.operations[0] === 'search';
  if (searchOnly) {
    if (config.defaultOrder) return;
    throw new Error(
      `defineTable: table '${table}' exposes only 'search' with an unresolved primary key ` +
      `('${missing[0]}'), so it must declare a 'defaultOrder' — otherwise the search orders ` +
      `by that missing column.`
    );
  }

  const exposed = config.operations
    ? `operations [${config.operations.join(', ')}]`
    : 'every operation (no `operations` whitelist, so all routes are exposed)';
  throw new Error(
    `defineTable: primary key field '${missing[0]}' is not a schema field on table ` +
    `'${table}', and the table exposes ${exposed} — those address rows by the primary key. ` +
    `Name a column that is unique in this relation, or restrict the table to ` +
    `operations: ['search'] with an explicit defaultOrder.`
  );
}

/**
 * `writeExclude` names schema fields that no write may carry. A field outside the schema is a
 * typo; the primary key is refused because the update body identifies the row with it; and a
 * field that is also `readExclude`d would be neither readable nor writable, which is what
 * removing it from the Schema means — keeping it there only grows the surface for nothing.
 */
function validateWriteExclude(config: ITable): void {
  const excluded = config.writeExclude;
  if (!excluded?.length) return;

  const schemaFields = Object.keys(config.Schema.fields);
  const pkFields = Array.isArray(config.primary) ? config.primary : [config.primary];
  const table = config.Schema.tableName;

  for (const field of excluded) {
    if (!schemaFields.includes(field)) {
      throw new Error(
        `defineTable: writeExclude field '${field}' is not a schema field on table '${table}'.`
      );
    }
    if (pkFields.includes(field)) {
      throw new Error(
        `defineTable: writeExclude cannot cover the primary key field '${field}' on table ` +
        `'${table}' — the update body identifies the row with it.`
      );
    }
    if (config.readExclude?.includes(field)) {
      throw new Error(
        `defineTable: field '${field}' on table '${table}' is in both readExclude and ` +
        `writeExclude, leaving it neither readable nor writable. Remove it from the Schema instead.`
      );
    }
  }
}

function validateComputedFields(config: ITable): void {
  const computed = config.computedFields;
  if (!computed) return;

  const schemaFields = Object.keys(config.Schema.fields);
  const extraKeys = Object.keys(config.extraFilters || {});

  for (const name of Object.keys(computed)) {
    if (schemaFields.includes(name)) {
      throw new Error(
        `defineTable: computedFields name '${name}' collides with a schema field on ` +
        `table '${config.Schema.tableName}'. Choose a different name.`
      );
    }
    if (extraKeys.includes(name)) {
      throw new Error(
        `defineTable: computedFields name '${name}' collides with an extraFilters key on ` +
        `table '${config.Schema.tableName}'. Choose a different name.`
      );
    }
  }
}

function validateAliasUniqueness(
  joins: JoinDefinition[] | undefined,
  label: string
): void {
  if (!joins?.length) return;
  const seen = new Set<string>();
  for (const j of joins) {
    if (seen.has(j.alias)) {
      throw new Error(
        `defineTable: duplicate alias '${j.alias}' in ${label}. ` +
        `When omitted, alias defaults to joinSchema.tableName — ` +
        `declare an explicit alias to disambiguate.`
      );
    }
    seen.add(j.alias);
  }
}

export interface BuildRelationOptions {
  alias?: string;
  selection?: string;
  unique?: boolean;
  /**
   * Allowlist of the target table's fields reachable through this relation.
   *
   * The relation is declared against a schema narrowed to these fields, so every read
   * surface — `selection`, `filters`, `conditions`, `orderBy`, aggregations, and the
   * generated request/response schemas — rejects anything outside the list with
   * `400 Unknown field`. Use it to expose a table broadly while keeping some of its
   * columns out of one relation, without hiding them from the table's own routes the way
   * `readExclude` would.
   *
   * Fail-closed: a column added to the table later is not reachable through the relation
   * until it is added here. Must include the join field, and is not allowed on a write
   * join.
   */
  fields?: string[];
}

/**
 * Copy of `schema` exposing only `fields`, in schema declaration order.
 *
 * `tableName`, `col` and `colMap` are carried over untouched: the engine resolves the
 * target's configuration through `dbTables[joinSchema.tableName]`, so a narrowed relation
 * must still answer to its real table name, and column mapping must keep working for the
 * fields that survive.
 */
function narrowSchemaToFields<J extends Record<string, TSchema>>(
  schema: SchemaDefinition<J>,
  fields: string[],
  joinField: string
): SchemaDefinition<J> {
  const declared = Object.keys(schema.fields);

  for (const field of fields) {
    if (!declared.includes(field)) {
      throw new Error(
        `buildRelation: 'fields' entry '${field}' is not a field of schema ` +
        `'${schema.tableName}'. Available: ${declared.join(', ')}.`
      );
    }
  }

  // The join field is what ties the fetched rows back to the main result set. Dropping it
  // from the projection would hand the caller rows it cannot match to anything.
  if (!fields.includes(joinField)) {
    throw new Error(
      `buildRelation: 'fields' must include the join field '${joinField}' on ` +
      `'${schema.tableName}' — it is what correlates the joined rows with the main ones.`
    );
  }

  const picked: Record<string, TSchema> = {};
  for (const field of declared) {
    if (fields.includes(field)) picked[field] = (schema.fields as Record<string, TSchema>)[field];
  }

  return {
    ...schema,
    fields: picked as J,
    validation: Type.Object(picked),
    partialValidation: Type.Partial(Type.Object(picked)),
  };
}

export function buildRelation<
  M extends Record<string, TSchema>,
  J extends Record<string, TSchema>,
>(
  mainSchema: SchemaDefinition<M>,
  mainField: string & keyof M | (string & keyof M)[],
  joinSchema: SchemaDefinition<J>,
  joinField: string & keyof J,
  options?: BuildRelationOptions
): JoinDefinition {
  const fields = options?.fields;
  return {
    joinSchema: fields ? narrowSchemaToFields(joinSchema, fields, joinField) : joinSchema,
    joinField,
    mainField,
    alias: options?.alias ?? joinSchema.tableName,
    selection: options?.selection ?? '*',
    unique: options?.unique ?? false,
    ...(fields ? { fields: [...fields] } : {}),
  };
}

export function buildUpsertRule<F extends Record<string, TSchema>>(
  schema: SchemaDefinition<F>,
  columns: (string & keyof F)[]
): [SchemaDefinition, string[]] {
  return [schema, columns];
}

export function buildUpsertRules(
  ...rules: [SchemaDefinition, string[]][]
): Map<SchemaDefinition, string[]> {
  return new Map(rules);
}
