import { Expression } from 'node-condition-builder';
import type { ConditionBuilder } from 'node-condition-builder';
import type { Queryable, SqlResult, DbRecord, SelectOptions } from '../types.js';
import type { SqlDialect } from './dialect.js';
import { getDialect } from './dialect.js';

// Default chunk size for bulk INSERT/UPSERT. Picked to keep parameter count well under
// PostgreSQL's hard limit of 65535 bind parameters per statement (≈ 130 columns × 500 rows).
// Override per-call via the `chunkSize` argument when working with extremely wide tables.
const DEFAULT_CHUNK_SIZE = 500;

/** @deprecated Use db.qi() instead */
export const escapeIdent = (f: string) => f.replace(/"/g, '""');

export class QueryClient {
  private client: Queryable;
  private dialect: SqlDialect;
  private debug = false;

  constructor(client: Queryable, dialect?: SqlDialect) {
    this.client = client;
    this.dialect = dialect ?? getDialect('postgres');
  }

  get qi(): (id: string) => string {
    return this.dialect.qi;
  }

  get ph(): (i: number) => string {
    return this.dialect.ph;
  }

  get dialectName(): string {
    return this.dialect.name;
  }

  /** ConditionBuilder dialect ('postgres' | 'mysql') for per-instance builders. */
  get cbDialect(): SqlDialect['cbDialect'] {
    return this.dialect.cbDialect;
  }

  /** Whether the dialect supports `RETURNING` (postgres/mariadb: yes, mysql: no). */
  get supportsReturning(): boolean {
    return this.dialect.supportsReturning;
  }

  /** Build the ` RETURNING <quoted pk>` suffix ('' when unsupported). */
  get returningPk(): SqlDialect['returningPk'] {
    return this.dialect.returningPk.bind(this.dialect);
  }

  get dateTrunc(): SqlDialect['dateTrunc'] {
    return this.dialect.dateTrunc.bind(this.dialect);
  }

  setDebug(mode: boolean): void {
    this.debug = mode;
  }

  expression(value: string): Expression {
    return new Expression(value);
  }

  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<SqlResult<T>> {
    if (this.debug) {
      console.log('SQL:', text.replace(/\s+/g, ' ').trim());
      console.log('PARAMS:', values || []);
    }
    return this.client.query<T>(text, values);
  }

  /**
   * Run `fn` inside a DB transaction on a dedicated connection (BEGIN/COMMIT, with
   * ROLLBACK + rethrow on error). Requires the underlying Queryable to expose
   * `connect()`; when it does not (legacy custom adapters), `fn` runs directly on
   * this client without transactional guarantees.
   *
   * Nested calls join the outer transaction: the tx QueryClient wraps a dedicated
   * connection that has no `connect()`, so an inner `withTransaction` is a no-op
   * wrapper around the same connection.
   */
  async withTransaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T> {
    if (!this.client.connect) return fn(this);

    const conn = await this.client.connect();
    const tx = new QueryClient(conn, this.dialect);
    tx.setDebug(this.debug);

    try {
      await conn.query('BEGIN');
      const result = await fn(tx);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch {
        // The connection is broken: surface the original error, not the rollback failure.
      }
      throw err;
    } finally {
      await conn.release();
    }
  }

  // Quote a list of fields
  #q(fields: string[]): string {
    return fields.map((f) => this.dialect.qi(f)).join(', ');
  }

  // Appends record fields/values to a shared values array, auto-indexing placeholders
  #params(
    record: DbRecord,
    values: unknown[]
  ): { fields: string[]; placeholders: string[] } {
    const fields: string[] = [];
    const placeholders: string[] = [];

    for (const [field, val] of Object.entries(record)) {
      fields.push(field);
      if (val instanceof Expression) {
        placeholders.push(val.value);
      } else {
        values.push(val);
        placeholders.push(this.dialect.ph(values.length));
      }
    }

    return { fields, placeholders };
  }

  // Builds `col = placeholder` pairs joined by `separator` (', ' for SET, ' AND ' for WHERE)
  #equalities(record: DbRecord, values: unknown[], separator: string): string {
    const { fields, placeholders } = this.#params(record, values);
    return fields.map((f, i) => `${this.dialect.qi(f)} = ${placeholders[i]}`).join(separator);
  }

  // Builds multi-row VALUES string for bulk operations
  #bulkValues(
    fields: string[],
    records: DbRecord[]
  ): { values: unknown[]; rows: string } {
    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];

    for (const record of records) {
      const cols: string[] = [];
      for (const field of fields) {
        const val = record[field];
        if (val instanceof Expression) {
          cols.push(val.value);
        } else {
          values.push(val);
          cols.push(this.dialect.ph(values.length));
        }
      }
      rowPlaceholders.push(`(${cols.join(', ')})`);
    }

    return { values, rows: rowPlaceholders.join(', ') };
  }

  #quotedPkCols(pkCol: string | string[]): string {
    const cols = Array.isArray(pkCol) ? pkCol : [pkCol];
    return cols.map((c) => this.dialect.qi(c)).join(', ');
  }

  #insertHead(table: string, fields: string[]): string {
    return `INSERT INTO ${this.dialect.qi(table)} (${this.#q(fields)})`;
  }

  #mysqlPkRow(pkCol: string | string[], record: DbRecord, insertId?: number): Record<string, unknown> {
    const cols = Array.isArray(pkCol) ? pkCol : [pkCol];
    const result: Record<string, unknown> = {};
    for (const col of cols) {
      if (col in record && record[col] != null) {
        result[col] = record[col];
      }
    }
    if (Object.keys(result).length > 0) return result;
    if (!Array.isArray(pkCol)) return { [pkCol]: insertId };
    return result;
  }

  /**
   * Single source of truth for "extract PK rows from an insert/upsert result". When the
   * dialect supports RETURNING (postgres/mariadb), returns `result.rows` directly. Otherwise
   * (mysql) synthesizes PK rows from `insertId` + the input records (assumes
   * `auto_increment_increment=1` for multi-row inserts).
   */
  #extractPkRows(
    result: SqlResult,
    pkCol: string | string[],
    inputs: DbRecord[]
  ): Record<string, unknown>[] {
    if (this.dialect.supportsReturning) return result.rows;
    const firstId = result.insertId;
    return inputs.map((rec, j) =>
      this.#mysqlPkRow(pkCol, rec, typeof firstId === 'number' ? firstId + j : undefined)
    );
  }

  async insert(
    table: string,
    record: DbRecord,
    pkCol: string | string[]
  ): Promise<Record<string, unknown>> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(record, values);
    if (!fields.length) throw new Error('Cannot execute empty insert');

    const returning = this.dialect.returningPk(this.#quotedPkCols(pkCol));

    const result = await this.query(
      `${this.#insertHead(table, fields)}
       VALUES (${placeholders.join(', ')})${returning}`,
      values
    );

    return this.#extractPkRows(result, pkCol, [record])[0];
  }

  async insertOrUpdate(
    table: string,
    record: DbRecord,
    conflictKeys: string[],
    pkCol: string | string[]
  ): Promise<Record<string, unknown>> {
    if (!Object.keys(record).length) throw new Error('Cannot execute empty insert');
    const [pkRow] = await this.#bulkWrite(table, [record], pkCol, 1, { conflictKeys, keepAsIs: conflictKeys });
    return pkRow;
  }

  /**
   * Group records by their exact field set, keeping each record's input position. A bulk write
   * is N single writes issued efficiently (ADR 0003), so every record writes only its own
   * fields: records with different fields cannot share a statement, or a field missing from
   * the statement is dropped and a field missing from the record is bound as NULL — which
   * skips the column default on insert and overwrites the stored value on upsert.
   */
  #groupByFields(records: DbRecord[]): { fields: string[]; indexes: number[] }[] {
    const groups = new Map<string, { fields: string[]; indexes: number[] }>();
    records.forEach((record, i) => {
      const fields = Object.keys(record);
      const key = JSON.stringify([...fields].sort());
      const group = groups.get(key);
      if (group) group.indexes.push(i);
      else groups.set(key, { fields, indexes: [i] });
    });
    return [...groups.values()];
  }

  /**
   * PK rows for upsert records that update nothing on conflict: the statement leaves an
   * existing row untouched, and neither RETURNING (postgres `DO NOTHING`) nor `insertId`
   * (mysql) tells anything about it. The record gives its PK when it holds every PK column;
   * otherwise the row — inserted or untouched — is looked up by its conflict keys, which
   * identify it uniquely.
   */
  async #untouchedPkRows(
    table: string,
    records: DbRecord[],
    pkCol: string | string[],
    conflictKeys: string[]
  ): Promise<Record<string, unknown>[]> {
    const pkCols = Array.isArray(pkCol) ? pkCol : [pkCol];
    const pkRows: Record<string, unknown>[] = [];

    for (const record of records) {
      if (pkCols.every((c) => record[c] != null && !(record[c] instanceof Expression))) {
        pkRows.push(Object.fromEntries(pkCols.map((c) => [c, record[c]])));
        continue;
      }
      const values: unknown[] = [];
      const where = this.#equalities(
        Object.fromEntries(conflictKeys.map((k) => [k, record[k]])), values, ' AND '
      );
      const result = await this.query(
        `SELECT ${this.#quotedPkCols(pkCol)} FROM ${this.dialect.qi(table)} WHERE ${where}`,
        values
      );
      if (!result.rows.length) {
        throw new Error(
          `Cannot resolve the primary key of an upserted "${table}" row: no row matches its conflict keys (${conflictKeys.join(', ')})`
        );
      }
      pkRows.push(result.rows[0]);
    }

    return pkRows;
  }

  /**
   * Multi-row INSERT, one statement per chunk of each same-fields group (a single statement
   * when every record has the same fields). With `upsert`, a conflicting row gets the
   * record's non-key fields; `keepAsIs` are the columns never overwritten on conflict. PK rows
   * are returned in input order.
   */
  async #bulkWrite(
    table: string,
    records: DbRecord[],
    pkCol: string | string[],
    chunkSize: number,
    upsert?: { conflictKeys: string[]; keepAsIs: string[] }
  ): Promise<Record<string, unknown>[]> {
    const returning = this.dialect.returningPk(this.#quotedPkCols(pkCol));
    const results: Record<string, unknown>[] = new Array(records.length);

    for (const { fields, indexes } of this.#groupByFields(records)) {
      const updateSet = upsert ? this.dialect.upsertUpdateSet(fields, upsert.keepAsIs) : '';
      const tail = upsert ? this.dialect.upsertSql(this.#q(upsert.conflictKeys), updateSet) : '';
      for (let i = 0; i < indexes.length; i += chunkSize) {
        const chunkIndexes = indexes.slice(i, i + chunkSize);
        const chunk = chunkIndexes.map((j) => records[j]);
        const { values, rows } = this.#bulkValues(fields, chunk);
        const result = await this.query(
          `${this.#insertHead(table, fields)}
           VALUES ${rows}
           ${tail}${returning}`,
          values
        );
        const pkRows = upsert && !updateSet
          ? await this.#untouchedPkRows(table, chunk, pkCol, upsert.conflictKeys)
          : this.#extractPkRows(result, pkCol, chunk);
        pkRows.forEach((row, k) => {
          results[chunkIndexes[k]] = row;
        });
      }
    }

    return results;
  }

  async bulkInsert(
    table: string,
    records: DbRecord[],
    pkCol: string | string[],
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<Record<string, unknown>[]> {
    if (!records.length) return [];
    return this.#bulkWrite(table, records, pkCol, chunkSize);
  }

  /**
   * `immutableCols` are written when the row is inserted but left untouched when the statement
   * lands on an existing row — like the conflict keys, which are never in the update set either.
   * Used by tenant isolation to keep an upsert from re-assigning a row's owner.
   */
  async bulkInsertOrUpdate(
    table: string,
    records: DbRecord[],
    conflictKeys: string[],
    pkCol: string | string[],
    chunkSize = DEFAULT_CHUNK_SIZE,
    immutableCols: string[] = []
  ): Promise<Record<string, unknown>[]> {
    if (!records.length) return [];

    const keepAsIs = immutableCols.length ? [...conflictKeys, ...immutableCols] : conflictKeys;
    return this.#bulkWrite(table, records, pkCol, chunkSize, { conflictKeys, keepAsIs });
  }

  async update(
    table: string,
    record: DbRecord,
    where: DbRecord,
    extraCondition?: ConditionBuilder
  ): Promise<number> {
    const values: unknown[] = [];
    const setClause = this.#equalities(record, values, ', ');
    const whereClause = this.#equalities(where, values, ' AND ');

    let extraWhere = '';
    if (extraCondition) {
      extraWhere = ` AND ${extraCondition.build(values.length + 1, this.dialect.ph)}`;
      values.push(...extraCondition.getValues());
    }

    const result = await this.query(
      `UPDATE ${this.dialect.qi(table)}
       SET ${setClause}
       WHERE ${whereClause}${extraWhere}`,
      values
    );
    return result.affectedRows;
  }

  async delete(
    table: string,
    where: DbRecord,
    extraCondition?: ConditionBuilder
  ): Promise<number> {
    const values: unknown[] = [];
    const whereClause = this.#equalities(where, values, ' AND ');

    let extraWhere = '';
    if (extraCondition) {
      extraWhere = ` AND ${extraCondition.build(values.length + 1, this.dialect.ph)}`;
      values.push(...extraCondition.getValues());
    }

    const result = await this.query(
      `DELETE FROM ${this.dialect.qi(table)}
       WHERE ${whereClause}${extraWhere}`,
      values
    );
    return result.affectedRows;
  }

  async select<T = Record<string, unknown>>({
    tableName,
    columns = '*',
    where,
    values,
    limit = null,
    orderBy = '',
    joins = [],
    distinct = false,
  }: SelectOptions): Promise<T[]> {
    const cols = columns === '*' ? `${this.dialect.qi(tableName)}.*` : columns;
    const parts = [
      `SELECT${distinct ? ' DISTINCT' : ''} ${cols}`,
      `FROM ${this.dialect.qi(tableName)}`,
      ...joins,
      `WHERE ${where}`,
    ];
    if (orderBy) parts.push(`ORDER BY ${orderBy}`);
    if (limit !== null) parts.push(`LIMIT ${limit}`);

    const result = await this.query<T>(parts.join('\n'), values);
    return result.rows;
  }
}

export function createQueryClient(
  pool: Queryable,
  dialectName?: string
): QueryClient {
  const dialect = getDialect((dialectName || 'postgres') as import('./dialect.js').DialectName);
  return new QueryClient(pool, dialect);
}
