import { ConditionBuilder } from 'node-condition-builder';
import type { TSchema } from '@sinclair/typebox';
import type {
  SchemaDefinition,
  JoinDefinition,
  ExtendedConditionFn,
  TableFilterFn,
  ITable,
} from '../types.js';

export function exportTableInfo<F extends Record<string, TSchema>>(
  Schema: SchemaDefinition<F>,
  extraFilters: Record<string, TSchema> = {},
  extendedCondition?: ExtendedConditionFn
): { Schema: SchemaDefinition<F>; filters: TableFilterFn; extraFilters: Record<string, TSchema> } {
  const filters: TableFilterFn = (filterValues: Record<string, unknown>) => {
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

  return { Schema, filters, extraFilters };
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
