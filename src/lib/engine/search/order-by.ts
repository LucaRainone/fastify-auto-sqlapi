/**
 * Parsing and validation of ordering, in its three dotted forms:
 *   1-part  `field`              schema field or computed
 *   2-part  `alias.field`        a joinLeft parent field, via a real LEFT JOIN
 *   3-part  `alias.fn.field`     a joinGroup aggregation, via a correlated subquery
 *
 * The request `orderBy` is validated strictly; `defaultOrder` from the table config is
 * deliberately lenient — see `convertConfiguredOrder`.
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
import { buildAggOrderExpr } from './aggregations.js';
import type { DbTables, ITable, JoinGroupRequest } from '../../../types.js';

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
 * count is known. Validates each alias against `allowedReadJoins` (throws 400), mirroring
 * `validateOrderBy`; 3-part aggregation entries are ignored (they use joinGroup, not a LEFT JOIN).
 */
export function collectOrderByLeftAliases(orderBy: string, tableConf: ITable): Set<string> {
  const aliases = new Set<string>();
  for (const part of orderBy.split(',')) {
    const trimmed = part.trim();
    if (/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.test(trimmed)) continue; // 3-part aggregation
    const m = /^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (m) {
      const alias = m[1];
      requireJoin(tableConf, alias, true);
      aliases.add(alias);
    }
  }
  return aliases;
}

export function validateOrderBy(
  orderBy: string,
  tableConf: ITable,
  db: QueryClient,
  dbTables: DbTables,
  joinGroup: Record<string, JoinGroupRequest> | undefined,
  startIdx: number
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
        err400('Cannot combine distinctResults with aggregation orderBy');
      }
      const [, alias, fn, field, dir] = dotted3;
      const expr = buildAggOrderExpr(db, dbTables, tableConf, alias, fn, field, joinGroup);
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
      const joinDef = requireJoin(tableConf, alias, true);
      const col = validateSchemaField(
        field, joinDef.joinSchema, dbTables[joinDef.joinSchema.tableName]
      );
      // Reference the LEFT JOIN'd table via its alias (SQL identifier).
      outParts.push(`${db.qi(alias)}.${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`);
      leftJoinAliases.add(alias);
      continue;
    }

    // 1-part: <field> [ASC|DESC] — schema field or computed
    const plain = /^(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (!plain) {
      err400(`Invalid orderBy: ${trimmed}`);
    }
    const [, field, dir] = plain;
    const ref = resolveFieldRef(field, tableConf.Schema, tableConf, db);
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
 * Converts a configured order (`defaultOrder` or the primary-key fallback) to SQL.
 * Unlike the request `orderBy` (strictly validated by `validateOrderBy`), this is
 * lenient for backward compatibility: tokens matching a camelCase schema field are
 * mapped to their quoted DB column, computed fields (without bound values) expand
 * to their expression, and anything else passes through unchanged as raw SQL.
 */
export function convertConfiguredOrder(
  order: string,
  tableConf: ITable,
  db: QueryClient
): string {
  return order
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const match = /^(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
      if (match) {
        const [, field, dir] = match;
        const suffix = dir ? ` ${dir.toUpperCase()}` : '';
        if (field in tableConf.Schema.fields) {
          return `${db.qi(tableConf.Schema.tableName)}.${db.qi(tableConf.Schema.col(field))}${suffix}`;
        }
        const computed = tableConf.computedFields?.[field];
        if (computed) {
          const ev = evaluateComputedField(
            field, computed, tableConf.Schema, db, undefined,
            `Computed field '${field}' with bound values cannot be used in defaultOrder`,
          );
          return `${ev.value}${suffix}`;
        }
      }
      return trimmed;
    })
    .join(', ');
}
