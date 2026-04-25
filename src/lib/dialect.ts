export type DialectName = 'postgres' | 'mysql' | 'mariadb';

export type TruncateUnit = 'year' | 'quarter' | 'month' | 'day' | 'hour';

export interface SqlDialect {
  name: DialectName;
  /** Quote identifier: "id" (postgres) or `id` (mysql/mariadb) */
  qi(id: string): string;
  /** Placeholder: $1 (postgres) or ? (mysql/mariadb) */
  ph(index: number): string;
  /** ConditionBuilder dialect name */
  cbDialect: 'postgres' | 'mysql';
  supportsReturning: boolean;
  /** ON CONFLICT / ON DUPLICATE KEY syntax */
  upsertSql(quotedConflictKeys: string, quotedUpdateSet: string): string;
  /** RETURNING pk_col suffix or empty string */
  returningPk(quotedPkCol: string): string;
  /**
   * Build the SET body for an upsert: the column list (separated by ', ') that the dialect
   * uses to copy "incoming row" values into a conflicting row.
   * - postgres: `"col" = EXCLUDED."col"`
   * - mysql/mariadb: `` `col` = VALUES(`col`) ``
   * Returns '' when there is nothing to update (i.e. all `fields` are conflict keys).
   */
  upsertUpdateSet(fields: string[], conflictKeys: string[]): string;
  /**
   * Truncate a timestamp/date column to the start of the given unit and
   * return it as an ISO-style string. The output is always a STRING:
   *  - year/quarter/month/day → 'YYYY-MM-DD' (e.g. '2026-04-01')
   *  - hour                    → 'YYYY-MM-DDTHH:00:00'
   * `qualifiedCol` is a fully-qualified, already-quoted column expression.
   */
  dateTrunc(unit: TruncateUnit, qualifiedCol: string): string;
}

const PostgresDialect: SqlDialect = {
  name: 'postgres',
  qi: (id) => `"${id.replace(/"/g, '""')}"`,
  ph: (i) => `$${i}`,
  cbDialect: 'postgres',
  supportsReturning: true,
  upsertSql(quotedConflictKeys, quotedUpdateSet) {
    if (!quotedUpdateSet) return `ON CONFLICT (${quotedConflictKeys}) DO NOTHING`;
    return `ON CONFLICT (${quotedConflictKeys}) DO UPDATE SET ${quotedUpdateSet}`;
  },
  upsertUpdateSet(fields, conflictKeys) {
    const updateCols = fields.filter((f) => !conflictKeys.includes(f));
    if (!updateCols.length) return '';
    return updateCols.map((f) => `${this.qi(f)} = EXCLUDED.${this.qi(f)}`).join(', ');
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

function mysqlUpsertUpdateSet(this: SqlDialect, fields: string[], conflictKeys: string[]): string {
  const updateCols = fields.filter((f) => !conflictKeys.includes(f));
  if (!updateCols.length) return '';
  return updateCols.map((f) => `${this.qi(f)} = VALUES(${this.qi(f)})`).join(', ');
}

const MysqlDialect: SqlDialect = {
  name: 'mysql',
  qi: (id) => `\`${id.replace(/`/g, '``')}\``,
  ph: () => '?',
  cbDialect: 'mysql',
  supportsReturning: false,
  upsertSql(_quotedConflictKeys, quotedUpdateSet) {
    // MySQL requires at least one assignment in ON DUPLICATE KEY UPDATE; when there's nothing
    // user-meaningful to update, assign the first conflict key to itself (no-op).
    if (!quotedUpdateSet) return `ON DUPLICATE KEY UPDATE ${_quotedConflictKeys.split(', ')[0]} = ${_quotedConflictKeys.split(', ')[0]}`;
    return `ON DUPLICATE KEY UPDATE ${quotedUpdateSet}`;
  },
  upsertUpdateSet: mysqlUpsertUpdateSet,
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
  upsertSql(_quotedConflictKeys, quotedUpdateSet) {
    if (!quotedUpdateSet) return `ON DUPLICATE KEY UPDATE ${_quotedConflictKeys.split(', ')[0]} = ${_quotedConflictKeys.split(', ')[0]}`;
    return `ON DUPLICATE KEY UPDATE ${quotedUpdateSet}`;
  },
  upsertUpdateSet: mysqlUpsertUpdateSet,
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
