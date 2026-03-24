export type DialectName = 'postgres' | 'mysql' | 'mariadb';

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
  returningPk(quotedPkCol) {
    return ` RETURNING ${quotedPkCol}`;
  },
};

const MysqlDialect: SqlDialect = {
  name: 'mysql',
  qi: (id) => `\`${id.replace(/`/g, '``')}\``,
  ph: () => '?',
  cbDialect: 'mysql',
  supportsReturning: false,
  upsertSql(_quotedConflictKeys, quotedUpdateSet) {
    if (!quotedUpdateSet) return `ON DUPLICATE KEY UPDATE ${_quotedConflictKeys.split(', ')[0]} = ${_quotedConflictKeys.split(', ')[0]}`;
    return `ON DUPLICATE KEY UPDATE ${quotedUpdateSet}`;
  },
  returningPk() {
    return '';
  },
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
  returningPk(quotedPkCol) {
    return ` RETURNING ${quotedPkCol}`;
  },
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
