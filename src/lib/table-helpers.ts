import { ConditionBuilder, type ConditionValueOrUndefined, type DialectName as CbDialect } from 'node-condition-builder';
import type { TSchema, TObject } from '@sinclair/typebox';
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
      if (field in filterValues && filterValues[field] !== null && filterValues[field] !== undefined) {
        condition.isEqual(`${table}.${qi(Schema.col(field), dialect)}`, filterValues[field]);
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
      : extraFilters as Record<string, TSchema>;

  return { Schema, filters, extraFilters: efRecord };
}

export function defineTable<F extends Record<string, TSchema>>(
  config: ITable<F>
): ITable<F> {
  validateAliasUniqueness(config.allowedReadJoins, 'allowedReadJoins');
  validateAliasUniqueness(config.allowedWriteJoins, 'allowedWriteJoins');
  validateComputedFields(config as unknown as ITable);
  validateReadExclude(config as unknown as ITable);
  return config;
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
  return {
    joinSchema,
    joinField,
    mainField,
    alias: options?.alias ?? joinSchema.tableName,
    selection: options?.selection ?? '*',
    unique: options?.unique ?? false,
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
