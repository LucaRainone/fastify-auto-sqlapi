import type { QueryResult, QueryResultRow } from 'pg';
import { Expression } from 'node-condition-builder';
import type { ConditionBuilder } from 'node-condition-builder';
import type { Queryable, DbRecord, SelectOptions } from '../types.js';

const DEFAULT_CHUNK_SIZE = 500;

const q = (fields: string[]) => fields.map((f) => `"${f}"`).join(', ');

export class QueryClient {
  private pg: Queryable;
  private debug = false;

  constructor(client: Queryable) {
    this.pg = client;
  }

  setDebug(mode: boolean): void {
    this.debug = mode;
  }

  expression(value: string): Expression {
    return new Expression(value);
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.debug) {
      console.log('SQL:', text.replace(/\s+/g, ' ').trim());
      console.log('PARAMS:', values || []);
    }
    return this.pg.query<T>(text, values);
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
        placeholders.push(`$${values.length}`);
      }
    }

    return { fields, placeholders };
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
          cols.push(`$${values.length}`);
        }
      }
      rowPlaceholders.push(`(${cols.join(', ')})`);
    }

    return { values, rows: rowPlaceholders.join(', ') };
  }

  async insert<T extends QueryResultRow = QueryResultRow>(
    table: string,
    record: DbRecord
  ): Promise<T> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(record, values);
    if (!fields.length) throw new Error('Cannot execute empty insert');

    const result = await this.query<T>(
      `INSERT INTO "${table}" (${q(fields)})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );
    return result.rows[0];
  }

  async insertOrUpdate<T extends QueryResultRow = QueryResultRow>(
    table: string,
    record: DbRecord,
    conflictKeys: string[]
  ): Promise<T> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(record, values);
    if (!fields.length) throw new Error('Cannot execute empty insert');

    const updateCols = fields.filter((f) => !conflictKeys.includes(f));
    const onConflict = updateCols.length
      ? `DO UPDATE SET ${updateCols.map((f) => `"${f}" = EXCLUDED."${f}"`).join(', ')}`
      : 'DO NOTHING';

    const result = await this.query<T>(
      `INSERT INTO "${table}" (${q(fields)})
       VALUES (${placeholders.join(', ')})
       ON CONFLICT (${q(conflictKeys)}) ${onConflict}
       RETURNING *`,
      values
    );
    return result.rows[0];
  }

  async bulkInsert<T extends QueryResultRow = QueryResultRow>(
    table: string,
    records: DbRecord[],
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<T[]> {
    if (!records.length) return [];

    const fields = Object.keys(records[0]);
    const results: T[] = [];

    for (let i = 0; i < records.length; i += chunkSize) {
      const { values, rows } = this.#bulkValues(
        fields,
        records.slice(i, i + chunkSize)
      );
      const result = await this.query<T>(
        `INSERT INTO "${table}" (${q(fields)}) VALUES ${rows} RETURNING *`,
        values
      );
      results.push(...result.rows);
    }

    return results;
  }

  async bulkInsertOrUpdate<T extends QueryResultRow = QueryResultRow>(
    table: string,
    records: DbRecord[],
    conflictKeys: string[],
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<T[]> {
    if (!records.length) return [];

    const fields = Object.keys(records[0]);
    const updateCols = fields.filter((f) => !conflictKeys.includes(f));
    const onConflict = updateCols.length
      ? `DO UPDATE SET ${updateCols.map((f) => `"${f}" = EXCLUDED."${f}"`).join(', ')}`
      : 'DO NOTHING';
    const results: T[] = [];

    for (let i = 0; i < records.length; i += chunkSize) {
      const { values, rows } = this.#bulkValues(
        fields,
        records.slice(i, i + chunkSize)
      );
      const result = await this.query<T>(
        `INSERT INTO "${table}" (${q(fields)})
         VALUES ${rows}
         ON CONFLICT (${q(conflictKeys)}) ${onConflict}
         RETURNING *`,
        values
      );
      results.push(...result.rows);
    }

    return results;
  }

  async update<T extends QueryResultRow = QueryResultRow>(
    table: string,
    record: DbRecord,
    where: DbRecord,
    extraCondition?: ConditionBuilder,
    options: { returning?: boolean } = { returning: true }
  ): Promise<T[]> {
    const values: unknown[] = [];
    const { fields: setF, placeholders: setP } = this.#params(record, values);
    const { fields: whereF, placeholders: whereP } = this.#params(
      where,
      values
    );

    let extraWhere = '';
    if (extraCondition) {
      extraWhere = ` AND ${extraCondition.build(values.length + 1, (i) => `$${i}`)}`;
      values.push(...extraCondition.getValues());
    }

    const returning = options.returning ? ' RETURNING *' : '';

    const result = await this.query<T>(
      `UPDATE "${table}"
       SET ${setF.map((f, i) => `"${f}" = ${setP[i]}`).join(', ')}
       WHERE ${whereF.map((f, i) => `"${f}" = ${whereP[i]}`).join(' AND ')}${extraWhere}${returning}`,
      values
    );
    return result.rows;
  }

  async delete<T extends QueryResultRow = QueryResultRow>(
    table: string,
    where: DbRecord
  ): Promise<T[]> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(where, values);

    const result = await this.query<T>(
      `DELETE FROM "${table}"
       WHERE ${fields.map((f, i) => `"${f}" = ${placeholders[i]}`).join(' AND ')}
       RETURNING *`,
      values
    );
    return result.rows;
  }

  async select<T extends QueryResultRow = QueryResultRow>({
    tableName,
    columns = '*',
    where,
    values,
    limit = null,
    orderBy = '',
    joins = [],
    distinct = false,
  }: SelectOptions): Promise<T[]> {
    const cols = columns === '*' ? `"${tableName}".*` : columns;
    const parts = [
      `SELECT${distinct ? ' DISTINCT' : ''} ${cols}`,
      `FROM "${tableName}"`,
      ...joins,
      `WHERE ${where}`,
    ];
    if (orderBy) parts.push(`ORDER BY ${orderBy}`);
    if (limit !== null) parts.push(`LIMIT ${limit}`);

    const result = await this.query<T>(parts.join('\n'), values);
    return result.rows;
  }
}
