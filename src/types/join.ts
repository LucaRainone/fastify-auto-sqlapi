import type { SchemaDefinition } from './schema.js';
import type { FilterRecord } from './table.js';
import type { SearchCondition } from './conditions.js';

export interface JoinDefinition {
  joinSchema: SchemaDefinition;
  joinField: string;
  mainField: string | string[];
  alias: string;
  selection: string;
  unique: boolean;
  /**
   * Allowlist of the target table's fields reachable through this relation, when
   * `buildRelation` was given one. `joinSchema` is already narrowed to it — this is kept
   * so the engine can tell a restricted relation from a full one, which is what stops the
   * default `'*'` selection from falling back to a real `SELECT *`.
   *
   * Read joins only: a write join declaring it is rejected by `defineTable`.
   */
  fields?: string[];
}

export interface AggregationRequest {
  /**
   * GROUP BY field. Either a schema field name on the join table or a
   * computed-field name declared on the join table's `computedFields`.
   */
  by?: string;
  distinctCount?: string[];
  min?: string[];
  max?: string[];
  sum?: string[];
  avg?: string[];
  count?: string[];
}

export interface JoinGroupRequest {
  aggregations: AggregationRequest;
  filters?: FilterRecord;
  conditions?: SearchCondition[];
}

/**
 * Reference filter for join-based existential filtering (joinMustExist),
 * virtual joins data fetching (joinMultiple), and parent inline (joinLeft).
 * Combines equality-based filters with rich ConditionBuilder-powered conditions,
 * both applied to the join schema.
 */
export interface JoinRefFilter {
  filters?: FilterRecord;
  conditions?: SearchCondition[];
}

/** Per-request override of the per-relation default selection. */
export interface JoinFetchRequest extends JoinRefFilter {
  selection?: string;
}
