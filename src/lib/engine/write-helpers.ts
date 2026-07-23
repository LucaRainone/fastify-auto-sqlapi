import type { FastifyRequest } from 'fastify';
import { camelcaseObject, snakecaseRecord } from '../naming.js';
import type { QueryClient } from '../db.js';
import { runValidation } from './validate.js';
import type {
  ITable,
  DbTables,
  JoinDefinition,
  DbRecord,
} from '../../types.js';

export function findWriteJoin(
  tableConf: ITable,
  alias: string
): JoinDefinition | undefined {
  return tableConf.allowedWriteJoins?.find((j) => j.alias === alias);
}

/**
 * Drop `excludeFromCreation` columns from a snake_case (DB-format) record.
 *
 * Exclusion is a whitelist on CLIENT input: call this on the client payload only,
 * BEFORE any server-side value is assigned (beforeInsert mutations, FK auto-fill),
 * so engine/hook-generated values on those fields reach the SQL.
 */
export function removeExcludedFields(
  record: Record<string, unknown>,
  tableConf: ITable
): Record<string, unknown> {
  if (!tableConf.excludeFromCreation?.length) return record;
  const result = { ...record };
  for (const field of tableConf.excludeFromCreation) {
    const col = tableConf.Schema.col(field);
    delete result[col];
  }
  return result;
}

/**
 * Same whitelist as `removeExcludedFields`, but for a camelCase record (schema
 * field names) and in place. Used on the client payload before the beforeInsert
 * hook runs.
 */
export function removeExcludedFieldsCamel(
  record: Record<string, unknown>,
  tableConf: ITable
): void {
  if (!tableConf.excludeFromCreation?.length) return;
  for (const field of tableConf.excludeFromCreation) {
    delete record[field];
  }
}

export function findSecondaryTableConf(
  dbTables: DbTables,
  joinTableName: string
): ITable | undefined {
  for (const [, conf] of Object.entries(dbTables)) {
    if (conf.Schema.tableName === joinTableName) return conf;
  }
  return undefined;
}

interface PrepareCtx {
  db: QueryClient;
  tableConf: ITable;
  request: FastifyRequest;
}

/**
 * Prepare a single record for INSERT/UPSERT:
 *   1. shallow camelCase copy of `input`
 *   2. runValidation (camelCase — sees the client payload as sent)
 *   3. drop excludeFromCreation fields (client-input whitelist; applied BEFORE the
 *      hook so values it assigns — e.g. a server-generated id — reach the INSERT)
 *   4. beforeInsert hook (caller can mutate the camelCase copy)
 *   5. snakecaseRecord → DB format
 *
 * Returns both `camel` (input + hook mutations, used for FK auto-fill / afterInsert) and
 * `snake` (DB-ready record). The original `input` is left intact.
 *
 * Pass `secondaries` so the validate hook receives them; pass undefined to skip
 * secondaries-aware validation (e.g. when a bulk-level validator already ran).
 */
export async function prepareInsertRecord(
  ctx: PrepareCtx,
  input: Record<string, unknown>,
  secondaries?: Record<string, Record<string, unknown>[]>,
  options?: { skipValidate?: boolean }
): Promise<{ camel: Record<string, unknown>; snake: Record<string, unknown> }> {
  const camel: Record<string, unknown> = { ...input };
  if (!options?.skipValidate) {
    await runValidation(ctx.db, ctx.request, ctx.tableConf, camel, secondaries);
  }
  removeExcludedFieldsCamel(camel, ctx.tableConf);
  if (ctx.tableConf.beforeInsert) {
    await ctx.tableConf.beforeInsert(
      ctx.db,
      ctx.request,
      camel as Parameters<NonNullable<typeof ctx.tableConf.beforeInsert>>[2]
    );
  }
  const snake = snakecaseRecord(camel, ctx.tableConf.Schema);
  return { camel, snake };
}

export async function processSecondaries(
  db: QueryClient,
  tableConf: ITable,
  dbTables: DbTables,
  mainRecord: Record<string, unknown>,
  secondaries: Record<string, Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, records] of Object.entries(secondaries)) {
    if (!records?.length) continue;

    const joinDef = findWriteJoin(tableConf, alias);
    if (!joinDef) continue;

    const { joinSchema, joinField, mainField } = joinDef;
    const joinCol = joinSchema.col(joinField);
    const secondaryTableConf = findSecondaryTableConf(dbTables, joinSchema.tableName);
    const secondaryPk = secondaryTableConf?.primary || joinField;
    const secondaryPkCol = Array.isArray(secondaryPk)
      ? secondaryPk.map((f) => joinSchema.col(f))
      : joinSchema.col(secondaryPk);

    const preparedRecords = records.map((rec) => {
      let prepared = snakecaseRecord(rec, joinSchema);

      // Remove excluded fields from the client payload BEFORE the FK auto-fill:
      // an excluded FK column must not strip the engine-injected value below.
      if (secondaryTableConf) {
        prepared = removeExcludedFields(prepared, secondaryTableConf);
      }

      // Auto-fill FK from main record
      const mainValue = Array.isArray(mainField)
        ? mainRecord[mainField[0]]
        : mainRecord[mainField as string];
      prepared[joinCol] = mainValue;

      return prepared;
    });

    const secondaryUpsertKeys = tableConf.upsertMap?.get(joinSchema);
    let pkRows: Record<string, unknown>[];

    if (secondaryUpsertKeys) {
      const conflictCols = secondaryUpsertKeys.map((k) => joinSchema.col(k));
      pkRows = await db.bulkInsertOrUpdate(
        joinSchema.tableName,
        preparedRecords as DbRecord[],
        conflictCols,
        secondaryPkCol
      );
    } else {
      pkRows = await db.bulkInsert(
        joinSchema.tableName,
        preparedRecords as DbRecord[],
        secondaryPkCol
      );
    }

    results[alias] = pkRows.map((r) =>
      camelcaseObject(r as Record<string, unknown>, joinSchema)
    );
  }

  return results;
}

/**
 * Process per-alias deletion requests for a write join.
 *
 * The FK from `mainRecord` (matching `joinDef.mainField` → `joinDef.joinField`) is
 * auto-injected into every deletion record. This means the consumer can provide just
 * the PK (e.g. `{ id: 5 }`) and the engine will run
 * `DELETE FROM child WHERE id = 5 AND fk_to_main = <main.id>` — both ergonomic
 * (no need to repeat the FK) and safer (cannot accidentally delete a row that
 * doesn't belong to this main).
 */
export async function processDeletions(
  db: QueryClient,
  tableConf: ITable,
  mainRecord: Record<string, unknown>,
  deletions: Record<string, Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, records] of Object.entries(deletions)) {
    if (!records?.length) continue;

    const joinDef = findWriteJoin(tableConf, alias);
    if (!joinDef) continue;

    const { joinSchema, joinField, mainField } = joinDef;
    const joinCol = joinSchema.col(joinField);
    const mainValue = Array.isArray(mainField)
      ? mainRecord[mainField[0]]
      : mainRecord[mainField as string];

    const deletedRows: Record<string, unknown>[] = [];

    for (const rec of records) {
      const snaked = snakecaseRecord(rec, joinSchema) as DbRecord;
      // Auto-inject FK to main: scopes the DELETE to children owned by this main.
      snaked[joinCol] = mainValue as DbRecord[string];
      const affectedRows = await db.delete(joinSchema.tableName, snaked);
      if (affectedRows > 0) {
        deletedRows.push(camelcaseObject(snaked as Record<string, unknown>, joinSchema));
      }
    }

    results[alias] = deletedRows;
  }

  return results;
}
