import type { ConditionBuilder } from 'node-condition-builder';
import type { QueryClient } from '../db.js';

/**
 * Owns the bound values of a statement while it is being assembled.
 *
 * A statement is built from several fragments (WHERE condition, EXISTS subqueries,
 * aggregation clauses, LEFT JOIN filters, ORDER BY), each of which must number its
 * placeholders from wherever the preceding fragments left off. Computing that offset at the
 * call site is how placeholders drift out of step with values — a query that binds a value
 * nobody references does not fail, it silently reads the wrong parameter.
 *
 * Here the offset is derived in exactly one place. `emit` hands a producer the index its
 * first placeholder must take and absorbs the values it returned in the same step, so SQL
 * and values cannot be appended independently.
 *
 * Fragments must be emitted in the order their placeholders appear in the final SQL: MySQL
 * binds `?` positionally, so a fragment numbered out of textual order would break there while
 * working on PostgreSQL.
 */
export class QueryParams {
  private values: unknown[] = [];

  /** Values bound so far. */
  get length(): number {
    return this.values.length;
  }

  /**
   * Render a fragment at the current offset and record the values it bound.
   * Returns whatever the producer returned, so callers can read its SQL and any extras.
   */
  emit<T extends { values: unknown[] }>(produce: (startIndex: number) => T): T {
    const out = produce(this.values.length + 1);
    this.values.push(...out.values);
    return out;
  }

  /** Render a ConditionBuilder at the current offset and return its SQL. */
  emitCondition(condition: ConditionBuilder, db: QueryClient): string {
    return this.emit((startIndex) => ({
      sql: condition.build(startIndex, db.ph),
      values: condition.getValues(),
    })).sql;
  }

  /**
   * Copy of the values bound so far. Take a snapshot before emitting a fragment that only
   * the main query carries (ORDER BY), so the COUNT/aggregate queries can bind the subset
   * they actually reference.
   */
  snapshot(): unknown[] {
    return [...this.values];
  }
}
