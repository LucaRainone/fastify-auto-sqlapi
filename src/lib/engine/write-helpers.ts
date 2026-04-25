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
 *   2. runValidation (camelCase)
 *   3. beforeInsert hook (caller can mutate the camelCase copy)
 *   4. snakecaseRecord → DB format
 *   5. removeExcludedFields
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
  if (ctx.tableConf.beforeInsert) {
    await ctx.tableConf.beforeInsert(
      ctx.db,
      ctx.request,
      camel as Parameters<NonNullable<typeof ctx.tableConf.beforeInsert>>[2]
    );
  }
  let snake = snakecaseRecord(camel, ctx.tableConf.Schema);
  snake = removeExcludedFields(snake, ctx.tableConf);
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

      // Auto-fill FK from main record
      const mainValue = Array.isArray(mainField)
        ? mainRecord[mainField[0]]
        : mainRecord[mainField as string];
      prepared[joinCol] = mainValue;

      // Remove excluded fields
      if (secondaryTableConf) {
        prepared = removeExcludedFields(prepared, secondaryTableConf);
      }

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

export async function processDeletions(
  db: QueryClient,
  tableConf: ITable,
  deletions: Record<string, Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, records] of Object.entries(deletions)) {
    if (!records?.length) continue;

    const joinDef = findWriteJoin(tableConf, alias);
    if (!joinDef) continue;

    const { joinSchema } = joinDef;
    const deletedRows: Record<string, unknown>[] = [];

    for (const rec of records) {
      const snaked = snakecaseRecord(rec, joinSchema) as DbRecord;
      const affectedRows = await db.delete(joinSchema.tableName, snaked);
      if (affectedRows > 0) {
        deletedRows.push(camelcaseObject(snaked as Record<string, unknown>, joinSchema));
      }
    }

    results[alias] = deletedRows;
  }

  return results;
}
