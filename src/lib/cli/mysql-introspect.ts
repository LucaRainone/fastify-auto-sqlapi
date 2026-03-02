import type { ColumnInfo } from '../../types.js';

export function buildMysqlConnectionConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
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
  connectionConfig: { host: string; port: number; user: string; password: string; database: string },
  schema: string
): Promise<ColumnInfo[]> {
  // Dynamic import: mysql2 is optional
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mysql2: any;
  try {
    mysql2 = await import('mysql2/promise' as string);
  } catch {
    throw new Error('mysql2 is required for MySQL/MariaDB introspection. Install it with: npm install mysql2');
  }
  const connection = await mysql2.createConnection(connectionConfig);

  try {
    const [rows] = await connection.query(
      `SELECT table_name, column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [schema]
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (rows as any[]).map((row: any) => ({
      table_name: row.TABLE_NAME || row.table_name,
      column_name: row.COLUMN_NAME || row.column_name,
      udt_name: mapMysqlType(row.DATA_TYPE || row.data_type),
      column_default: row.COLUMN_DEFAULT || row.column_default,
      is_nullable: row.IS_NULLABLE || row.is_nullable,
    }));
  } finally {
    await connection.end();
  }
}
