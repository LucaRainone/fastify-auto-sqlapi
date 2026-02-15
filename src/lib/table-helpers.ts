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
    const allFields = { ...Schema.fields, ...extraFilters };

    for (const field of Object.keys(allFields)) {
      if (field in filterValues && filterValues[field] !== null && filterValues[field] !== undefined) {
        // Use Schema.col for schema fields, toUnderscore for extraFilters
        const column = field in Schema.fields
          ? Schema.col(field)
          : Schema.col(field);
        condition.isEqual(column, filterValues[field]);
      }
    }

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
