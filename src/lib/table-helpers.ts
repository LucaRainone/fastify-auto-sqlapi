import { ConditionBuilder, type ConditionValueOrUndefined, type DialectName as CbDialect } from 'node-condition-builder';
import { Type, type TSchema, type TObject } from '@sinclair/typebox';
import type {
  SchemaDefinition,
  JoinDefinition,
  TableFilterFn,
  ITable,
} from '../types.js';
import { getDialect } from './dialect.js';

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
  validateReadExclude(config as unknown as ITable);
  return config;
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
