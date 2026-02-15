import { ConditionBuilder } from 'node-condition-builder';
import type { TSchema } from '@sinclair/typebox';
import type {
  SchemaDefinition,
  JoinDefinition,
  ExtendedConditionFn,
  TableFilterFn,
} from '../types.js';

export function exportTableInfo(
  Schema: SchemaDefinition,
  extraFilters: Record<string, TSchema> = {},
  extendedCondition?: ExtendedConditionFn
): { Schema: SchemaDefinition; filters: TableFilterFn; extraFilters: Record<string, TSchema> } {
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

export function buildRelation(
  mainSchema: SchemaDefinition,
  mainField: string | string[],
  joinSchema: SchemaDefinition,
  joinField: string,
  selection: string = '*'
): JoinDefinition {
  return [joinSchema, joinField, mainField, selection];
}

export function buildUpsertRule(
  schema: SchemaDefinition,
  columns: string[]
): [SchemaDefinition, string[]] {
  return [schema, columns];
}

export function buildUpsertRules(
  ...rules: [SchemaDefinition, string[]][]
): Map<SchemaDefinition, string[]> {
  return new Map(rules);
}
