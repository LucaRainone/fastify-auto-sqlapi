import { camelcaseObject } from '../../naming.js';
import {
  processSecondaries,
  processDeletions,
  prepareInsertRecord,
  assertUpsertKeys,
} from '../write-helpers.js';
import {
  enforceTenantOnWrites,
  assertTenantOwnsConflicts,
  tenantImmutableColumns,
} from '../../tenant.js';
import { runBulkValidation } from '../validate.js';
import { primaryAsCols } from '../../../types.js';
import type {
  BulkUpsertItem,
  BulkUpsertParams,
  BulkUpsertResult,
  DbRecord,
  WrittenRow,
} from '../../../types.js';

/** One bulk statement for every main row: its PK and what the statement did to it. */
async function upsertMains(
  params: BulkUpsertParams,
  preparedMains: DbRecord[],
  pkCol: string | string[]
): Promise<WrittenRow[]> {
  const { db, tableConf, tenant } = params;
  const schema = tableConf.Schema;
  const upsertKeys = tableConf.upsertMap?.get(schema);

  if (!upsertKeys) {
    const pkRows = await db.bulkInsert(schema.tableName, preparedMains, pkCol);
    return pkRows.map((pk) => ({ pk, action: 'inserted' }));
  }

  const conflictCols = upsertKeys.map((k) => schema.col(k));
  assertUpsertKeys(schema, conflictCols, [pkCol].flat(), preparedMains);
  // Tenant isolation: a conflicting upsert must not overwrite rows owned by another tenant, nor
  // re-assign the owner of a row it legitimately updates.
  await assertTenantOwnsConflicts(db, tenant, schema.tableName, conflictCols, preparedMains);
  return db.bulkInsertOrUpdateWithAction(
    schema.tableName, preparedMains, conflictCols, pkCol, undefined, tenantImmutableColumns(tenant)
  );
}

/** Secondaries, deletions and the afterInsert hook for one upserted item. */
async function finalizeUpsertedItem(
  params: BulkUpsertParams,
  item: BulkUpsertItem,
  inputMain: Record<string, unknown>,
  written: WrittenRow
): Promise<BulkUpsertResult> {
  const { db, tableConf, dbTables, request, tenant } = params;

  // The PK row comes from SQL RETURNING or mysql insertId synthesis — keys are DB column names;
  // camelcaseObject maps them back to schema fields (full composite PK).
  const mainPkCamel = camelcaseObject(written.pk, tableConf.Schema);
  const result: BulkUpsertResult = { main: mainPkCamel, action: written.action };

  // FK auto-fill: input camelCase + generated PK
  const mainForFK = { ...inputMain, ...mainPkCamel };

  if (item.secondaries && Object.keys(item.secondaries).length > 0) {
    const sec = await processSecondaries(
      { db, tableConf, dbTables, mainRecord: mainForFK, tenant, request }, item.secondaries
    );
    if (Object.keys(sec).length > 0) result.secondaries = sec;
  }

  if (item.deletions && Object.keys(item.deletions).length > 0) {
    const del = await processDeletions(
      { db, tableConf, dbTables, mainRecord: mainForFK, tenant, request }, item.deletions
    );
    if (Object.keys(del).length > 0) result.deletions = del;
  }

  if (tableConf.afterInsert) {
    await tableConf.afterInsert({ db, req: request, record: mainForFK, secondaries: result.secondaries });
  }

  return result;
}

export async function bulkUpsertEngine(params: BulkUpsertParams): Promise<BulkUpsertResult[]> {
  const { db, tableConf, request, items, tenant } = params;
  if (!items.length) return [];

  const schema = tableConf.Schema;
  // Full primary key columns — composite PKs need every column (see insertEngine).
  const pkCol = primaryAsCols(tableConf.primary, (f) => schema.col(f));

  // 1. Bulk validation runs once for all items (skips per-item validate). Otherwise per-item
  //    validation happens inside prepareInsertRecord below.
  if (tableConf.validateBulk) {
    await runBulkValidation(db, request, tableConf, items);
  }

  // 2. For each item: validate (unless validateBulk ran) → beforeInsert → snake → remove excluded.
  const prepared = await Promise.all(
    items.map((item) =>
      prepareInsertRecord(
        { db, tableConf, request },
        item.main,
        item.secondaries,
        { skipValidate: !!tableConf.validateBulk },
      ),
    ),
  );
  const inputMains = prepared.map((p) => p.camel);
  const preparedMains = prepared.map((p) => p.snake as DbRecord);

  // 3. Tenant: inject (direct) or batch-validate FK (indirect) — enforced after user mutations
  await enforceTenantOnWrites(db, tenant, preparedMains);

  // 4. Bulk upsert all mains in one query → PK and action per row
  const written = await upsertMains(params, preparedMains, pkCol);

  // 5-6. Secondaries, deletions and afterInsert per item — sequential on purpose, so hooks
  //      observe the same order the caller sent, and errors surface on the first bad item.
  const results: BulkUpsertResult[] = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await finalizeUpsertedItem(params, items[i], inputMains[i], written[i]));
  }

  return results;
}
