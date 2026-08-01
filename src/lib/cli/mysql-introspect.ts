import { loadOptionalDependency } from './load-dependency.js';
import type { ColumnInfo } from '../../types.js';

export interface MysqlConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * The slice of `mysql2/promise` this CLI actually uses.
 *
 * Declared locally rather than imported: mysql2 is an optional peer, so a real import
 * would break installs that only use Postgres, and its types would leak into the
 * published `.d.ts` and fail to resolve for consumers who never installed it.
 */
interface MysqlConnection {
  query(sql: string, values: unknown[]): Promise<[MysqlColumnRow[], unknown]>;
  end(): Promise<void>;
}

interface Mysql2Module {
  createConnection(config: MysqlConnectionConfig): Promise<MysqlConnection>;
}

/** information_schema.columns row. MySQL and MariaDB differ on column-name case. */
interface MysqlColumnRow {
  TABLE_NAME?: string;
  table_name?: string;
  COLUMN_NAME?: string;
  column_name?: string;
  DATA_TYPE?: string;
  data_type?: string;
  COLUMN_DEFAULT?: string | null;
  column_default?: string | null;
  IS_NULLABLE?: string;
  is_nullable?: string;
  COLUMN_KEY?: string;
  column_key?: string;
  EXTRA?: string;
  extra?: string;
}

export function buildMysqlConnectionConfig(): MysqlConnectionConfig {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port || '3306', 10),
      user: url.username,
      password: url.password,
      database: url.pathname.replace('/', ''),
    };
  }

  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'test',
    password: process.env.MYSQL_PASSWORD || 'test',
    database: process.env.MYSQL_DB || 'testdb',
  };
}

// Map MySQL DATA_TYPE to equivalent PG udt_name for schema-codegen compatibility
function mapMysqlType(dataType: string): string {
  switch (dataType.toLowerCase()) {
    case 'int':
    case 'mediumint':
      return 'int4';
    case 'smallint':
    case 'tinyint':
      return 'int2';
    case 'bigint':
      return 'int8';
    case 'decimal':
    case 'double':
    case 'float':
      return 'numeric';
    case 'varchar':
      return 'varchar';
    case 'char':
      return 'char';
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'tinytext':
      return 'text';
    case 'datetime':
    case 'timestamp':
      return 'timestamp';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'json':
      return 'json';
    case 'boolean':
    case 'bool':
      return 'bool';
    case 'enum':
      return 'varchar';
    case 'blob':
    case 'mediumblob':
    case 'longblob':
    case 'tinyblob':
      return 'text';
    default:
      return 'varchar';
  }
}

export async function introspectMysqlTables(
  connectionConfig: MysqlConnectionConfig,
  schema: string
): Promise<ColumnInfo[]> {
  const mysql2 = loadOptionalDependency<Mysql2Module>('mysql2/promise', 'npm install mysql2');
  const connection = await mysql2.createConnection(connectionConfig);

  try {
    const [rows] = await connection.query(
      `SELECT table_name, column_name, data_type, column_default, is_nullable, column_key, extra
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [schema]
    );

    // `||` is kept as-is from the untyped version: this change types the driver, it does
    // not alter behaviour. The trailing fallbacks only satisfy ColumnInfo, which cannot
    // hold `undefined`.
    return rows.map((row) => ({
      table_name: row.TABLE_NAME || row.table_name || '',
      column_name: row.COLUMN_NAME || row.column_name || '',
      udt_name: mapMysqlType(row.DATA_TYPE || row.data_type || ''),
      column_default: row.COLUMN_DEFAULT || row.column_default || null,
      is_nullable: row.IS_NULLABLE || row.is_nullable || '',
      is_primary: (row.COLUMN_KEY || row.column_key) === 'PRI',
      is_auto_increment: String(row.EXTRA || row.extra || '').includes('auto_increment'),
    }));
  } finally {
    await connection.end();
  }
}
