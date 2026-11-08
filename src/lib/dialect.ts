export type DialectName = 'postgres' | 'mysql' | 'mariadb';

type TruncateUnit = 'year' | 'quarter' | 'month' | 'day' | 'hour';

export interface SqlDialect {
  name: DialectName;
  /** Quote identifier: "id" (postgres) or `id` (mysql/mariadb) */
  qi(id: string): string;
  /** Placeholder: $1 (postgres) or ? (mysql/mariadb) */
  ph(index: number): string;
  /** ConditionBuilder dialect name */
  cbDialect: 'postgres' | 'mysql';
  supportsReturning: boolean;
  /**
   * The upsert clause of a dialect whose syntax names its conflict target — postgres
   * `ON CONFLICT (key)`, which matches exactly the declared key. Absent on mysql/mariadb:
   * `ON DUPLICATE KEY UPDATE` fires on ANY unique index, so there the QueryClient upserts by
   * key explicitly — probe, insert, update (ADR 0021).
   */
  onConflict?: {
    /** `ON CONFLICT (keys) DO UPDATE SET …`, or `DO NOTHING` when the update set is empty. */
    sql(quotedConflictKeys: string, quotedUpdateSet: string): string;
    /**
     * The SET body copying the incoming row into the conflicting one (`"col" = EXCLUDED."col"`)
     * for every field not in `keepAsIs`; '' when nothing is left to update.
     */
    updateSet(fields: string[], keepAsIs: string[]): string;
    /**
     * A boolean SQL expression for the RETURNING list that is true on a row the statement
     * inserted and false on one it updated, so an upsert can report what it did.
     */
    insertedFlag: string;
  };
  /** RETURNING pk_col suffix or empty string */
  returningPk(quotedPkCol: string): string;
  /**
   * Truncate a timestamp/date column to the start of the given unit and
   * return it as an ISO-style string. The output is always a STRING:
   *  - year/quarter/month/day → 'YYYY-MM-DD' (e.g. '2026-04-01')
   *  - hour                    → 'YYYY-MM-DDTHH:00:00'
   * `qualifiedCol` is a fully-qualified, already-quoted column expression.
   */
  dateTrunc(unit: TruncateUnit, qualifiedCol: string): string;
}

const pgQi = (id: string): string => `"${id.replace(/"/g, '""')}"`;

const PostgresDialect: SqlDialect = {
  name: 'postgres',
  qi: pgQi,
  ph: (i) => `$${i}`,
  cbDialect: 'postgres',
  supportsReturning: true,
  onConflict: {
    sql(quotedConflictKeys, quotedUpdateSet) {
      if (!quotedUpdateSet) return `ON CONFLICT (${quotedConflictKeys}) DO NOTHING`;
      return `ON CONFLICT (${quotedConflictKeys}) DO UPDATE SET ${quotedUpdateSet}`;
    },
    updateSet(fields, keepAsIs) {
      const updateCols = fields.filter((f) => !keepAsIs.includes(f));
      return updateCols.map((f) => `${pgQi(f)} = EXCLUDED.${pgQi(f)}`).join(', ');
    },
    // A freshly inserted row has no deleting/updating transaction recorded: xmax is 0. A row
    // `ON CONFLICT DO UPDATE` rewrote carries the current transaction's id there.
    insertedFlag: '(xmax = 0)',
  },
  returningPk(quotedPkCol) {
    return ` RETURNING ${quotedPkCol}`;
  },
  dateTrunc(unit, col) {
    const fmt = unit === 'hour' ? `'YYYY-MM-DD"T"HH24:00:00'` : `'YYYY-MM-DD'`;
    // DATE_TRUNC accepts a literal unit string, never user input — `unit` is whitelisted upstream.
    return `TO_CHAR(DATE_TRUNC('${unit}', ${col}), ${fmt})`;
  },
};

function mysqlDateTrunc(unit: TruncateUnit, col: string): string {
  switch (unit) {
    case 'year':    return `DATE_FORMAT(${col}, '%Y-01-01')`;
    case 'quarter': return `CONCAT(YEAR(${col}), '-', LPAD((QUARTER(${col})-1)*3+1, 2, '0'), '-01')`;
    case 'month':   return `DATE_FORMAT(${col}, '%Y-%m-01')`;
    case 'day':     return `DATE_FORMAT(${col}, '%Y-%m-%d')`;
    case 'hour':    return `DATE_FORMAT(${col}, '%Y-%m-%dT%H:00:00')`;
  }
}

const MysqlDialect: SqlDialect = {
  name: 'mysql',
  qi: (id) => `\`${id.replace(/`/g, '``')}\``,
  ph: () => '?',
  cbDialect: 'mysql',
  supportsReturning: false,
  returningPk() {
    return '';
  },
  dateTrunc: mysqlDateTrunc,
};

const MariadbDialect: SqlDialect = {
  name: 'mariadb',
  qi: (id) => `\`${id.replace(/`/g, '``')}\``,
  ph: () => '?',
  cbDialect: 'mysql',
  supportsReturning: true,
  returningPk(quotedPkCol) {
    return ` RETURNING ${quotedPkCol}`;
  },
  dateTrunc: mysqlDateTrunc,
};

const dialects: Record<DialectName, SqlDialect> = {
  postgres: PostgresDialect,
  mysql: MysqlDialect,
  mariadb: MariadbDialect,
};

export function getDialect(name: DialectName): SqlDialect {
  const d = dialects[name];
  if (!d) throw new Error(`Unknown dialect: ${name}`);
  return d;
}
