import { ConditionBuilder, type ConditionValueOrUndefined } from 'node-condition-builder';
import type { TSchema, TObject } from '@sinclair/typebox';
import type {
  SchemaDefinition,
  JoinDefinition,
  TableFilterFn,
  ITable,
} from '../types.js';

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
  const filters: TableFilterFn = (filterValues) => {
    const condition = new ConditionBuilder('AND');

    // Only auto-match real schema fields (DB columns)
    for (const field of Object.keys(Schema.fields)) {
      if (field in filterValues && filterValues[field] !== null && filterValues[field] !== undefined) {
        condition.isEqual(Schema.col(field), filterValues[field]);
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
  return config;
}

export function buildRelation<
  M extends Record<string, TSchema>,
  J extends Record<string, TSchema>,
>(
  mainSchema: SchemaDefinition<M>,
  mainField: string & keyof M | (string & keyof M)[],
  joinSchema: SchemaDefinition<J>,
  joinField: string & keyof J,
  selection: string = '*'
): JoinDefinition {
  return [joinSchema, joinField, mainField, selection];
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
