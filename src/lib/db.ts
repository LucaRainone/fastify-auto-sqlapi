import { Expression } from 'node-condition-builder';
import type { ConditionBuilder } from 'node-condition-builder';
import type { Queryable, SqlResult, DbRecord, SelectOptions, WrittenRow } from '../types.js';
import type { SqlDialect } from './dialect.js';
import { getDialect } from './dialect.js';

// Default chunk size for bulk INSERT/UPSERT. Picked to keep parameter count well under
// PostgreSQL's hard limit of 65535 bind parameters per statement (≈ 130 columns × 500 rows).
// Override per-call via the `chunkSize` argument when working with extremely wide tables.
const DEFAULT_CHUNK_SIZE = 500;
// Column tagging each row of an upsert key lookup with its record's position in the chunk
const LOOKUP_POSITION = 'sqlapi_lookup_position';
// Column carrying the dialect's inserted/updated flag in an upsert's RETURNING list
const INSERTED_FLAG = '__inserted';

const asInserted = (pkRows: Record<string, unknown>[]): WrittenRow[] =>
  pkRows.map((pk) => ({ pk, action: 'inserted' }));

/** What an upsert matches on, and the columns it never overwrites on an existing row. */
interface UpsertTarget {
  conflictKeys: string[];
  keepAsIs: string[];
}

export class QueryClient {
  private client: Queryable;
  private dialect: SqlDialect;
  private debug = false;
  /** True on the client `withTransaction` hands its callback: it wraps the transaction's connection. */
  private readonly inTransaction: boolean;

  constructor(client: Queryable, dialect?: SqlDialect, inTransaction = false) {
    this.client = client;
    this.dialect = dialect ?? getDialect('postgres');
    this.inTransaction = inTransaction;
  }

  /** Whether `withTransaction` can run: the Queryable has `connect()`, or this client already is a transaction. */
  get supportsTransactions(): boolean {
    return this.inTransaction || typeof this.client.connect === 'function';
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
   * ROLLBACK + rethrow on error). Requires the underlying Queryable to expose `connect()`.
   *
   * Without it the call fails, and nothing runs: a write that asked for atomicity — a main
   * row with its secondaries, deletions and after-hooks — must not be executed as separate
   * autocommitted statements because the adapter cannot do better. It used to; a custom
   * adapter without `connect()` silently lost the guarantee (ADR 0023).
   *
   * Nested calls join the outer transaction: the tx QueryClient wraps the dedicated
   * connection, which has no `connect()` either, so an inner `withTransaction` runs `fn` on
   * the same connection. That is the one case where a missing `connect()` is not an error.
   */
  async withTransaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    if (!this.client.connect) {
      throw new Error(
        'Transactions are unavailable: the Queryable has no connect(). Pass a pool to pgQueryable()/' +
        'mysqlQueryable(), or implement connect() on the custom adapter: a write with secondaries, ' +
        'deletions or after-hooks runs in a transaction or not at all.'
      );
    }

    const conn = await this.client.connect();
    const tx = new QueryClient(conn, this.dialect, true);
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

  // The SQL for one value: a raw Expression inline, anything else bound as the next placeholder
  #bind(val: unknown, values: unknown[]): string {
    if (val instanceof Expression) return val.value;
    values.push(val);
    return this.dialect.ph(values.length);
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
      placeholders.push(this.#bind(val, values));
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
      rowPlaceholders.push(`(${fields.map((field) => this.#bind(record[field], values)).join(', ')})`);
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
    return (await this.insertOrUpdateWithAction(table, record, conflictKeys, pkCol)).pk;
  }

  /** `insertOrUpdate`, also telling whether the row was inserted or updated. */
  async insertOrUpdateWithAction(
    table: string,
    record: DbRecord,
    conflictKeys: string[],
    pkCol: string | string[]
  ): Promise<WrittenRow> {
    if (!Object.keys(record).length) throw new Error('Cannot execute empty insert');
    const [written] = await this.#bulkWrite(table, [record], pkCol, 1, { conflictKeys, keepAsIs: conflictKeys });
    return written;
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
   * Rows found by each record's key, keyed by the record's position. One statement for the
   * whole chunk: a `UNION ALL` part per record, each row tagged with its position, so the order
   * the database returns them in does not matter and value comparison stays the database's
   * (types, collations). Records whose key holds a null are not looked up: NULL never matches.
   */
  async #findByKey(
    table: string,
    records: DbRecord[],
    pkCol: string | string[],
    keys: string[]
  ): Promise<Map<number, Record<string, unknown>[]>> {
    const found = new Map<number, Record<string, unknown>[]>();
    const values: unknown[] = [];
    const position = this.dialect.qi(LOOKUP_POSITION);
    const from = `${this.#quotedPkCols(pkCol)} FROM ${this.dialect.qi(table)}`;

    const lookups = records.flatMap((record, i) => {
      if (keys.some((k) => record[k] == null)) return [];
      const where = this.#equalities(Object.fromEntries(keys.map((k) => [k, record[k]])), values, ' AND ');
      return [`SELECT ${i} AS ${position}, ${from} WHERE ${where}`];
    });
    if (!lookups.length) return found;

    const result = await this.query(lookups.join(' UNION ALL '), values);
    for (const { [LOOKUP_POSITION]: i, ...pk } of result.rows) {
      found.set(Number(i), [...(found.get(Number(i)) ?? []), pk]);
    }
    for (const rows of found.values()) {
      if (rows.length > 1) {
        throw new Error(
          `An upsert key (${keys.join(', ')}) of "${table}" matches several rows: it is not unique ` +
          `in the database — nothing was written (ADR 0021)`
        );
      }
    }
    return found;
  }

  /**
   * PK rows for postgres upsert records that update nothing on conflict: `DO NOTHING` returns no
   * row for an existing one. The record gives its PK when it holds every PK column; otherwise
   * the row — inserted or untouched — is looked up by its conflict keys.
   */
  async #untouchedPkRows(
    table: string,
    records: DbRecord[],
    pkCol: string | string[],
    conflictKeys: string[]
  ): Promise<Record<string, unknown>[]> {
    const pkCols = Array.isArray(pkCol) ? pkCol : [pkCol];
    const holdsPk = (record: DbRecord): boolean =>
      pkCols.every((c) => record[c] != null && !(record[c] instanceof Expression));

    const found = await this.#findByKey(
      table, records.map((r) => (holdsPk(r) ? {} : r)), pkCol, conflictKeys
    );
    return records.map((record, i) => {
      if (holdsPk(record)) return Object.fromEntries(pkCols.map((c) => [c, record[c]]));
      const [row] = found.get(i) ?? [];
      if (!row) {
        throw new Error(
          `Cannot resolve the primary key of an upserted "${table}" row: no row matches its conflict keys (${conflictKeys.join(', ')})`
        );
      }
      return row;
    });
  }

  /**
   * One multi-row INSERT for records sharing `fields`; `tail` is the upsert clause, if any, and
   * `extraReturning` an expression added to the RETURNING list where the dialect has one.
   * Returns the PK rows (plus that expression's column) in the records' order.
   */
  async #insertRows(
    table: string,
    fields: string[],
    records: DbRecord[],
    pkCol: string | string[],
    tail = '',
    extraReturning = ''
  ): Promise<Record<string, unknown>[]> {
    const { values, rows } = this.#bulkValues(fields, records);
    const returningPk = this.dialect.returningPk(this.#quotedPkCols(pkCol));
    const returning = returningPk && extraReturning ? `${returningPk}, ${extraReturning}` : returningPk;
    const result = await this.query(
      `${this.#insertHead(table, fields)}
       VALUES ${rows}
       ${tail}${returning}`,
      values
    );
    return this.#extractPkRows(result, pkCol, records);
  }

  /**
   * Update existing rows by their key in one statement: each column takes a `CASE` over the
   * keys, and the WHERE names the same keys, so a row can only be reached through its own key.
   * Every row must be matched: one deleted since it was read is an error, never a skipped write.
   */
  async #updateByKey(table: string, columns: string[], records: DbRecord[], keys: string[]): Promise<void> {
    const values: unknown[] = [];
    const match = (record: DbRecord): string =>
      `(${this.#equalities(Object.fromEntries(keys.map((k) => [k, record[k]])), values, ' AND ')})`;

    const set = columns.map((col) => {
      const cases = records.map((r) => `WHEN ${match(r)} THEN ${this.#bind(r[col], values)}`);
      return `${this.dialect.qi(col)} = CASE ${cases.join(' ')} END`;
    });
    const where = records.map(match).join(' OR ');

    const result = await this.query(
      `UPDATE ${this.dialect.qi(table)} SET ${set.join(', ')} WHERE ${where}`,
      values
    );
    if (result.affectedRows !== records.length) {
      throw new Error(
        `Upsert on "${table}": ${records.length - result.affectedRows} of ${records.length} rows ` +
        `to update were not found — deleted after the upsert read them`
      );
    }
  }

  /**
   * Upsert by key for dialects whose upsert syntax names no conflict target (mysql/mariadb,
   * ADR 0021): probe which keys exist, insert the rest, update the found rows by their key.
   * Only the row the key names can be written — a collision on another unique index is an
   * error, as it is on postgres. PKs come from the probe and from the insert.
   */
  async #upsertByKey(
    table: string,
    fields: string[],
    records: DbRecord[],
    pkCol: string | string[],
    upsert: UpsertTarget
  ): Promise<WrittenRow[]> {
    // A group missing a key field can only insert: nothing to probe
    const found = upsert.conflictKeys.every((k) => fields.includes(k))
      ? await this.#findByKey(table, records, pkCol, upsert.conflictKeys)
      : new Map<number, Record<string, unknown>[]>();
    const written: WrittenRow[] = new Array(records.length);

    const inserts = records.flatMap((_, i) => (found.has(i) ? [] : [i]));
    if (inserts.length) {
      const insertedRows = await this.#insertRows(table, fields, inserts.map((i) => records[i]), pkCol);
      inserts.forEach((i, k) => { written[i] = { pk: insertedRows[k], action: 'inserted' }; });
    }

    const updates = [...found.keys()];
    const columns = fields.filter((f) => !upsert.keepAsIs.includes(f));
    if (updates.length && columns.length) {
      await this.#updateByKey(table, columns, updates.map((i) => records[i]), upsert.conflictKeys);
    }
    for (const i of updates) written[i] = { pk: found.get(i)![0], action: 'updated' };

    return written;
  }

  /**
   * One chunk of records sharing `fields`: a plain insert, or an upsert — `ON CONFLICT (key)`
   * where the dialect has it, by key otherwise. Written rows in the records' order, each with
   * the action the statement took on it.
   */
  async #writeChunk(
    table: string,
    fields: string[],
    records: DbRecord[],
    pkCol: string | string[],
    upsert?: UpsertTarget
  ): Promise<WrittenRow[]> {
    if (!upsert) return asInserted(await this.#insertRows(table, fields, records, pkCol));

    const onConflict = this.dialect.onConflict;
    if (!onConflict) return this.#upsertByKey(table, fields, records, pkCol, upsert);

    const updateSet = onConflict.updateSet(fields, upsert.keepAsIs);
    const clause = onConflict.sql(this.#q(upsert.conflictKeys), updateSet);

    if (!updateSet) {
      // Nothing to update: `DO NOTHING` returns a row for each one it inserted and none for an
      // existing one. A group missing a key field can only insert, so RETURNING names every row;
      // otherwise every row's PK is looked up, and the ones RETURNING named are the inserted.
      const insertedRows = await this.#insertRows(table, fields, records, pkCol, clause);
      if (!upsert.conflictKeys.every((k) => fields.includes(k))) return asInserted(insertedRows);

      const pkCols = Array.isArray(pkCol) ? pkCol : [pkCol];
      const pkKey = (row: Record<string, unknown>): string => pkCols.map((c) => String(row[c])).join('|');
      const inserted = new Set(insertedRows.map(pkKey));
      const pkRows = await this.#untouchedPkRows(table, records, pkCol, upsert.conflictKeys);
      return pkRows.map((pk) => ({ pk, action: inserted.has(pkKey(pk)) ? 'inserted' : 'updated' }));
    }

    // The statement itself says which rows it inserted and which it rewrote.
    const rows = await this.#insertRows(
      table, fields, records, pkCol, clause,
      `${onConflict.insertedFlag} AS ${this.dialect.qi(INSERTED_FLAG)}`
    );
    return rows.map(({ [INSERTED_FLAG]: flag, ...pk }) => ({
      pk,
      action: flag === false ? 'updated' : 'inserted',
    }));
  }

  /**
   * Write `records`, one chunk at a time within each same-fields group (a single chunk when
   * every record has the same fields). With `upsert`, an existing row gets the record's fields
   * except `keepAsIs` — the conflict keys and the columns never overwritten. Written rows are
   * returned in input order.
   */
  async #bulkWrite(
    table: string,
    records: DbRecord[],
    pkCol: string | string[],
    chunkSize: number,
    upsert?: UpsertTarget
  ): Promise<WrittenRow[]> {
    const results: WrittenRow[] = new Array(records.length);

    for (const { fields, indexes } of this.#groupByFields(records)) {
      for (let i = 0; i < indexes.length; i += chunkSize) {
        const chunkIndexes = indexes.slice(i, i + chunkSize);
        const written = await this.#writeChunk(
          table, fields, chunkIndexes.map((j) => records[j]), pkCol, upsert
        );
        written.forEach((row, k) => {
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
    return (await this.#bulkWrite(table, records, pkCol, chunkSize)).map((r) => r.pk);
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
    const written = await this.bulkInsertOrUpdateWithAction(
      table, records, conflictKeys, pkCol, chunkSize, immutableCols
    );
    return written.map((r) => r.pk);
  }

  /** `bulkInsertOrUpdate`, also telling for each row whether it was inserted or updated. */
  async bulkInsertOrUpdateWithAction(
    table: string,
    records: DbRecord[],
    conflictKeys: string[],
    pkCol: string | string[],
    chunkSize = DEFAULT_CHUNK_SIZE,
    immutableCols: string[] = []
  ): Promise<WrittenRow[]> {
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
