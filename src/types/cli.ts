import type { DialectName } from '../lib/dialect.js';

export interface SqlApiConfig {
  outputDir: string;
  schema?: string;
  dialect?: DialectName;
  envFile?: string;
}

export interface ColumnInfo {
  table_name: string;
  column_name: string;
  udt_name: string;
  column_default: string | null;
  is_nullable: string;
}

export interface TableMap {
  [schemaName: string]: {
    name: string;
    fields: Record<string, string>;
    colMap: Record<string, string>;
  };
}
