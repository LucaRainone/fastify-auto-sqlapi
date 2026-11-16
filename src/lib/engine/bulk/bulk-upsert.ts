import { camelcaseObject } from '../../naming.js';
import {
  processSecondaries,
  processDeletions,
  prepareInsertRecord,
  assertUpsertKeys,
  assertWriteJoinAliases,
  hasAliases,
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
  RowsByAlias,
  WrittenRow,
} from '../../../types.js';

/** One bulk statement for every main row: its PK and what the statement did to it. */
async function upsertMains(
  params: BulkUpsertParams,
  preparedMains: DbRecord[],
  pkCol: string | string[]
): Promise<WrittenRow[]> {
  const { db, tableConf, tenant } = params;
  const schema = tableConf.schema;
  const upsertKeys = tableConf.upsertKey;

  if (!upsertKeys) {
    const pkRows = await db.bulkInsert(schema.tableName, preparedMains, pkCol);
    return pkRows.map((pk) => ({ pk, action: 'inserted' }));
  }

  const conflictCols = upsertKeys.map((k) => schema.col(k));
  assertUpsertKeys(schema, conflictCols, [pkCol].flat(), preparedMains);
  // Tenant isolation: a conflicting upsert must not overwrite rows owned by another tenant, nor
  // re-assign the owner of a row it legitimately updates.
  await assertTenantOwnsConflicts(db, tenant, schema.tableName, conflictCols, preparedMains);
  return db.bulkUpsert(
    schema.tableName, preparedMains, conflictCols, pkCol, { immutableCols: tenantImmutableColumns(tenant) }
  );
}

/**
 * The child rows and the afterInsert hook of one upserted item. The batch runs without a
 * transaction (ADR 0003), but an item with a `replace` runs this in a transaction of its own
 * (ADR 0029): its upsert and the removal of the rows it left out commit together, so the item
 * never ends with half its children replaced.
 */
function finalizeUpsertedItem(
  params: BulkUpsertParams,
  item: BulkUpsertItem,
  inputMain: Record<string, unknown>,
  written: WrittenRow
): Promise<BulkUpsertResult> {
  return hasAliases(item.replace)
    ? params.db.withTransaction((tx) => writeItemChildren({ ...params, db: tx }, item, inputMain, written))
    : writeItemChildren(params, item, inputMain, written);
}

async function writeItemChildren(
  params: BulkUpsertParams,
  item: BulkUpsertItem,
  inputMain: Record<string, unknown>,
  written: WrittenRow
): Promise<BulkUpsertResult> {
  const { db, tableConf, dbTables, request, tenant } = params;

  // The PK row comes from SQL RETURNING or mysql insertId synthesis — keys are DB column names;
  // camelcaseObject maps them back to schema fields (full composite PK).
  const mainPkCamel = camelcaseObject(written.pk, tableConf.schema);
  const result: BulkUpsertResult = { main: mainPkCamel, action: written.action };

  // FK auto-fill: input camelCase + generated PK
  const mainForFK = { ...inputMain, ...mainPkCamel };

  let removed: RowsByAlias = {};
  if (hasAliases(item.upsert, item.replace)) {
    const outcome = await processSecondaries(
      { db, tableConf, dbTables, mainRecord: mainForFK, tenant, request }, { upsert: item.upsert, replace: item.replace }
    );
    if (Object.keys(outcome.written).length > 0) result.secondaries = outcome.written;
    removed = outcome.removed;
  }

  if (hasAliases(item.delete)) {
    const del = await processDeletions(
      { db, tableConf, dbTables, mainRecord: mainForFK, tenant, request }, item.delete ?? {}
    );
    if (Object.keys(del).length > 0) result.deletions = del;
  }
  if (Object.keys(removed).length > 0) result.deletions = { ...result.deletions, ...removed };

  if (tableConf.afterInsert) {
    await tableConf.afterInsert({
      db, req: request, record: mainForFK, secondaries: result.secondaries, deletions: result.deletions,
    });
  }

  return result;
}

export async function bulkUpsertEngine(params: BulkUpsertParams): Promise<BulkUpsertResult[]> {
  const { db, tableConf, dbTables, request, items, tenant } = params;
  if (!items.length) return [];

  const schema = tableConf.schema;
  // Full primary key columns — composite PKs need every column (see insertEngine).
  const pkCol = primaryAsCols(tableConf.primary, (f) => schema.col(f));

  items.forEach((item, i) => assertWriteJoinAliases(tableConf, item, String(i)));

  // 1. Bulk validation runs once for all items (skips per-item validate). Otherwise per-item
  //    validation happens inside prepareInsertRecord below.
  if (tableConf.validateBulk) {
    await runBulkValidation(db, request, tableConf, items);
  }

  // 2. For each item: validate (unless validateBulk ran) → beforeInsert → snake → remove excluded.
  const prepared = await Promise.all(
    items.map((item, i) =>
      prepareInsertRecord(
        { db, tableConf, dbTables, request },
        item.main,
        { upsert: item.upsert, replace: item.replace },
        { skipValidate: !!tableConf.validateBulk, at: String(i) },
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
