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
  /** True when the column is part of the table's PRIMARY KEY (from information_schema). */
  is_primary?: boolean;
  /** True for auto-generated columns without a visible default (mysql AUTO_INCREMENT). */
  is_auto_increment?: boolean;
}

export interface TableMap {
  [schemaName: string]: {
    name: string;
    fields: Record<string, string>;
    colMap: Record<string, string>;
    /** PRIMARY KEY fields (camelCase), in table column order. Empty when unknown. */
    primary: string[];
  };
}
