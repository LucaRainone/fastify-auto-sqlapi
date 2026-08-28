import type { DialectName } from '../lib/dialect.js';

export interface SqlApiConfig {
  outputDir: string;
  schema?: string;
  dialect?: DialectName;
  envFile?: string;
  /**
   * Tables to skip during schema generation (`sqlapi-generate-schema`).
   * Matched against the DB table name; `*` is a wildcard (e.g. "knex_*").
   * Excluded schemas already on disk are removed as orphans on the next full run.
   */
  excludeTables?: string[];
}

export interface ColumnInfo {
  table_name: string;
  column_name: string;
  udt_name: string;
  column_default: string | null;
  is_nullable: string;
  /** True when the column is part of the table's PRIMARY KEY (from information_schema). */
  is_primary?: boolean;
  /**
   * True for columns the database fills in by itself without a visible `column_default`:
   * MySQL `AUTO_INCREMENT` and PostgreSQL `GENERATED ... AS IDENTITY`. Both behave like a
   * default — omit the column and the value appears — so the generated field is Optional and
   * the CLI lists it under `excludeFromCreation`.
   */
  is_auto_increment?: boolean;
  /**
   * True for a column computed from an expression: `GENERATED ALWAYS AS (<expr>)`, STORED on
   * PostgreSQL, VIRTUAL or STORED on MySQL. Unlike an identity column this one is never
   * writable at all — naming it in an INSERT or an UPDATE is an error on both engines — so it
   * is read-only for the whole API, not just at creation time.
   */
  is_generated?: boolean;
  /**
   * True when the relation is a view rather than a base table — `information_schema.tables`
   * on both engines, plus `pg_class.relkind = 'm'` for PostgreSQL materialized views, which
   * `information_schema` does not describe at all.
   *
   * A view is still a table config: what changes is what may be assumed about it. It carries
   * no PRIMARY KEY constraint, so `is_primary` is false on every column, and only a view
   * simple enough for the engine to make updatable accepts a write.
   */
  is_view?: boolean;
}

export interface TableMap {
  [schemaName: string]: {
    name: string;
    fields: Record<string, string>;
    colMap: Record<string, string>;
    /** PRIMARY KEY fields (camelCase), in table column order. Empty when unknown. */
    primary: string[];
    /** Database-computed fields (camelCase), in table column order. Never writable. */
    generated: string[];
    /** True when this relation is a view (or a materialized view), not a base table. */
    isView: boolean;
  };
}
