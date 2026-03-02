import { Expression } from 'node-condition-builder';
import type { ConditionBuilder } from 'node-condition-builder';
import type { Queryable, SqlResult, DbRecord, SelectOptions } from '../types.js';
import type { SqlDialect } from './dialect.js';
import { getDialect } from './dialect.js';

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

  // Build the update SET for upsert: dialect-specific
  #upsertUpdateSet(fields: string[], conflictKeys: string[]): string {
    const updateCols = fields.filter((f) => !conflictKeys.includes(f));
    if (!updateCols.length) return '';

    if (this.dialect.name === 'postgres') {
      return updateCols
        .map((f) => `${this.dialect.qi(f)} = EXCLUDED.${this.dialect.qi(f)}`)
        .join(', ');
    }
    // MySQL/MariaDB: VALUES(col) syntax
    return updateCols
      .map((f) => `${this.dialect.qi(f)} = VALUES(${this.dialect.qi(f)})`)
      .join(', ');
  }

  async insert(
    table: string,
    record: DbRecord,
    pkCol: string
  ): Promise<Record<string, unknown>> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(record, values);
    if (!fields.length) throw new Error('Cannot execute empty insert');

    const quotedPk = this.dialect.qi(pkCol);
    const returning = this.dialect.returningPk(quotedPk);

    const result = await this.query(
      `INSERT INTO ${this.dialect.qi(table)} (${this.#q(fields)})
       VALUES (${placeholders.join(', ')})${returning}`,
      values
    );

    if (this.dialect.supportsReturning) {
      return result.rows[0] as Record<string, unknown>;
    }

    // MySQL: PK from record or auto-increment insertId
    if (pkCol in record && record[pkCol] != null) {
      return { [pkCol]: record[pkCol] };
    }
    return { [pkCol]: result.insertId };
  }

  async insertOrUpdate(
    table: string,
    record: DbRecord,
    conflictKeys: string[],
    pkCol: string
  ): Promise<Record<string, unknown>> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(record, values);
    if (!fields.length) throw new Error('Cannot execute empty insert');

    const updateSet = this.#upsertUpdateSet(fields, conflictKeys);
    const upsertClause = this.dialect.upsertSql(this.#q(conflictKeys), updateSet);
    const quotedPk = this.dialect.qi(pkCol);
    const returning = this.dialect.returningPk(quotedPk);

    const result = await this.query(
      `INSERT INTO ${this.dialect.qi(table)} (${this.#q(fields)})
       VALUES (${placeholders.join(', ')})
       ${upsertClause}${returning}`,
      values
    );

    if (this.dialect.supportsReturning) {
      return result.rows[0] as Record<string, unknown>;
    }

    if (pkCol in record && record[pkCol] != null) {
      return { [pkCol]: record[pkCol] };
    }
    return { [pkCol]: result.insertId };
  }

  async bulkInsert(
    table: string,
    records: DbRecord[],
    pkCol: string,
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<Record<string, unknown>[]> {
    if (!records.length) return [];

    const fields = Object.keys(records[0]);
    const results: Record<string, unknown>[] = [];
    const quotedPk = this.dialect.qi(pkCol);
    const returning = this.dialect.returningPk(quotedPk);

    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      const { values, rows } = this.#bulkValues(fields, chunk);
      const result = await this.query(
        `INSERT INTO ${this.dialect.qi(table)} (${this.#q(fields)}) VALUES ${rows}${returning}`,
        values
      );

      if (this.dialect.supportsReturning) {
        results.push(...(result.rows as Record<string, unknown>[]));
      } else {
        // MySQL: use PK from records or auto-increment
        const hasPkInRecords = pkCol in chunk[0] && chunk[0][pkCol] != null;
        if (hasPkInRecords) {
          for (const rec of chunk) {
            results.push({ [pkCol]: rec[pkCol] });
          }
        } else {
          const baseId = result.insertId ?? 0;
          for (let j = 0; j < chunk.length; j++) {
            results.push({ [pkCol]: baseId + j });
          }
        }
      }
    }

    return results;
  }

  async bulkInsertOrUpdate(
    table: string,
    records: DbRecord[],
    conflictKeys: string[],
    pkCol: string,
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<Record<string, unknown>[]> {
    if (!records.length) return [];

    const fields = Object.keys(records[0]);
    const updateSet = this.#upsertUpdateSet(fields, conflictKeys);
    const upsertClause = this.dialect.upsertSql(this.#q(conflictKeys), updateSet);
    const quotedPk = this.dialect.qi(pkCol);
    const returning = this.dialect.returningPk(quotedPk);
    const results: Record<string, unknown>[] = [];

    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      const { values, rows } = this.#bulkValues(fields, chunk);
      const result = await this.query(
        `INSERT INTO ${this.dialect.qi(table)} (${this.#q(fields)})
         VALUES ${rows}
         ${upsertClause}${returning}`,
        values
      );

      if (this.dialect.supportsReturning) {
        results.push(...(result.rows as Record<string, unknown>[]));
      } else {
        const hasPkInRecords = pkCol in chunk[0] && chunk[0][pkCol] != null;
        if (hasPkInRecords) {
          for (const rec of chunk) {
            results.push({ [pkCol]: rec[pkCol] });
          }
        } else {
          const baseId = result.insertId ?? 0;
          for (let j = 0; j < chunk.length; j++) {
            results.push({ [pkCol]: baseId + j });
          }
        }
      }
    }

    return results;
  }

  async update(
    table: string,
    record: DbRecord,
    where: DbRecord,
    extraCondition?: ConditionBuilder
  ): Promise<number> {
    const values: unknown[] = [];
    const { fields: setF, placeholders: setP } = this.#params(record, values);
    const { fields: whereF, placeholders: whereP } = this.#params(
      where,
      values
    );

    let extraWhere = '';
    if (extraCondition) {
      extraWhere = ` AND ${extraCondition.build(values.length + 1, this.dialect.ph)}`;
      values.push(...extraCondition.getValues());
    }

    const result = await this.query(
      `UPDATE ${this.dialect.qi(table)}
       SET ${setF.map((f, i) => `${this.dialect.qi(f)} = ${setP[i]}`).join(', ')}
       WHERE ${whereF.map((f, i) => `${this.dialect.qi(f)} = ${whereP[i]}`).join(' AND ')}${extraWhere}`,
      values
    );
    return result.affectedRows;
  }

  async delete(
    table: string,
    where: DbRecord
  ): Promise<number> {
    const values: unknown[] = [];
    const { fields, placeholders } = this.#params(where, values);

    const result = await this.query(
      `DELETE FROM ${this.dialect.qi(table)}
       WHERE ${fields.map((f, i) => `${this.dialect.qi(f)} = ${placeholders[i]}`).join(' AND ')}`,
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
