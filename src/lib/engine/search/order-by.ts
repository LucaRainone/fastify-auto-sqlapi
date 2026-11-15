/**
 * Parsing and validation of ordering, in its three dotted forms:
 *   1-part  `field`              schema field or computed
 *   2-part  `alias.field`        a joinLeft parent field, via a real LEFT JOIN
 *   3-part  `alias.fn.field`     a joinGroup aggregation, via a correlated subquery
 *
 * The request `orderBy` is validated here per request; `defaultOrder` from the table config has
 * the 1-part grammar only, checked by `defineTable` — see `convertConfiguredOrder`.
 */
import type { QueryClient } from '../../db.js';
import {
  err400,
  validateSchemaField,
  resolveFieldRef,
  refValues,
  renderRef,
  evaluateComputedField,
} from './fields.js';
import { requireJoin } from './joins.js';
import { resolveJoinTableConf, PLAIN_ORDER_TERM, defaultOrderTermProblem, defaultOrderError } from '../../table-helpers.js';
import { hasOwnField, ownField } from '../../read-access.js';
import { buildAggOrderExpr } from './aggregations.js';
import type { DbTables, TableConfig, JoinGroupRequest, TenantContext } from '../../../types.js';

export interface OrderByResult {
  sql: string;
  values: unknown[];
  /** Aliases referenced in 2-part notation (joinLeft) — need a LEFT JOIN. */
  leftJoinAliases: Set<string>;
}

/**
 * Pre-scan `orderBy` for the joinLeft aliases referenced in 2-part notation (`<alias>.<field>`).
 * Needed BEFORE building the LEFT JOIN clauses (which must know their aliases) while the actual
 * orderBy SQL — with its parameter placeholders — is only baked later, once the LEFT JOIN value
 * count is known. Validates each alias against `readJoins` (throws 400), mirroring
 * `validateOrderBy`; 3-part aggregation entries are ignored (they use joinGroup, not a LEFT JOIN).
 */
export function collectOrderByLeftAliases(orderBy: string, tableConf: TableConfig): Set<string> {
  const aliases = new Set<string>();
  for (const part of orderBy.split(',')) {
    const trimmed = part.trim();
    if (/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.test(trimmed)) continue; // 3-part aggregation
    const m = /^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (m) {
      const alias = m[1];
      requireJoin(tableConf, alias, true, 'orderBy');
      aliases.add(alias);
    }
  }
  return aliases;
}

export function validateOrderBy(
  orderBy: string,
  tableConf: TableConfig,
  db: QueryClient,
  dbTables: DbTables,
  joinGroup: Record<string, JoinGroupRequest> | undefined,
  startIdx: number,
  tenant?: TenantContext
): OrderByResult {
  const parts = orderBy.split(',');
  const outParts: string[] = [];
  const outValues: unknown[] = [];
  const leftJoinAliases = new Set<string>();
  let currentIdx = startIdx;

  for (const part of parts) {
    const trimmed = part.trim();

    // 3-part: <alias>.<fn>.<field> [ASC|DESC] (aggregation via joinGroup)
    const dotted3 = /^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (dotted3) {
      if (tableConf.distinctResults) {
        err400('invalid_order_by', 'orderBy', 'Cannot combine distinctResults with aggregation orderBy');
      }
      const [, alias, fn, field, dir] = dotted3;
      const expr = buildAggOrderExpr(db, dbTables, tableConf, alias, fn, field, joinGroup, tenant, 'orderBy');
      const aggVals = [...expr.values];
      outParts.push(`${renderRef(expr, currentIdx, db)} ${(dir || 'ASC').toUpperCase()}`);
      outValues.push(...aggVals);
      currentIdx += aggVals.length;
      continue;
    }

    // 2-part: <alias>.<field> [ASC|DESC] (joinLeft inline ordering)
    const dotted2 = /^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (dotted2) {
      const [, alias, field, dir] = dotted2;
      const joinDef = requireJoin(tableConf, alias, true, 'orderBy');
      const col = validateSchemaField(
        field, joinDef.joinSchema, resolveJoinTableConf(dbTables, joinDef), 'orderBy'
      );
      // Reference the LEFT JOIN'd table via its alias (SQL identifier).
      outParts.push(`${db.qi(alias)}.${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`);
      leftJoinAliases.add(alias);
      continue;
    }

    // 1-part: <field> [ASC|DESC] — schema field or computed
    const plain = PLAIN_ORDER_TERM.exec(trimmed);
    if (!plain) {
      err400('invalid_order_by', 'orderBy', `Invalid orderBy: ${trimmed}`);
    }
    const [, field, dir] = plain;
    const ref = resolveFieldRef(field, tableConf.schema, tableConf, db, undefined, 'orderBy');
    // A computed field binds its own values here: ORDER BY is emitted after the WHERE, so
    // its placeholders continue from `currentIdx`.
    const refVals = refValues(ref.expr);
    outParts.push(`${renderRef(ref.expr, currentIdx, db)} ${(dir || 'ASC').toUpperCase()}`);
    outValues.push(...refVals);
    currentIdx += refVals.length;
  }

  return { sql: outParts.join(', '), values: outValues, leftJoinAliases };
}

/**
 * Converts a configured order (`defaultOrder` or the primary-key fallback) to SQL: each
 * `field [ASC|DESC]` term becomes the table-qualified column, or the expression of a computed
 * field (without bound values). `defineTable` has already refused anything else; a config
 * written by hand past it fails here, as a programming error, rather than reaching the SQL.
 */
export function convertConfiguredOrder(
  order: string,
  tableConf: TableConfig,
  db: QueryClient
): string {
  return order
    .split(',')
    .map((part) => {
      const term = part.trim();
      const problem = defaultOrderTermProblem(term, tableConf);
      if (problem) throw defaultOrderError('search', term, tableConf, problem);
      const [, field, dir] = PLAIN_ORDER_TERM.exec(term) as RegExpExecArray;
      const suffix = dir ? ` ${dir.toUpperCase()}` : '';
      if (hasOwnField(tableConf.schema.fields, field)) {
        return `${db.qi(tableConf.schema.tableName)}.${db.qi(tableConf.schema.col(field))}${suffix}`;
      }
      const ev = evaluateComputedField(
        field, ownField(tableConf.computedFields, field)!, tableConf.schema, db, undefined,
        `Computed field '${field}' with bound values cannot be used in defaultOrder`,
      );
      return `${ev.value}${suffix}`;
    })
    .join(', ');
}
