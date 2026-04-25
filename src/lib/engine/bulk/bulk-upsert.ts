import { processSecondaries, processDeletions, prepareInsertRecord } from '../write-helpers.js';
import { enforceTenantOnWrites } from '../../tenant.js';
import { runBulkValidation } from '../validate.js';
import { primaryAsString } from '../../../types.js';
import type {
  BulkUpsertParams,
  BulkUpsertResult,
  DbRecord,
} from '../../../types.js';

export async function bulkUpsertEngine(params: BulkUpsertParams): Promise<BulkUpsertResult[]> {
  const { db, tableConf, dbTables, request, items, tenant } = params;
  if (!items.length) return [];

  const schema = tableConf.Schema;
  const pk = primaryAsString(tableConf.primary);
  const pkCol = schema.col(pk);

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
  await enforceTenantOnWrites(db, tenant, preparedMains as Record<string, unknown>[]);

  // 4. Bulk upsert all mains in one query → returns PK-only
  const upsertKeys = tableConf.upsertMap?.get(schema);
  let pkRows: Record<string, unknown>[];
  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => schema.col(k));
    pkRows = await db.bulkInsertOrUpdate(
      schema.tableName,
      preparedMains,
      conflictCols,
      pkCol
    );
  } else {
    pkRows = await db.bulkInsert(
      schema.tableName,
      preparedMains,
      pkCol
    );
  }

  // 5. Process secondaries, deletions, afterInsert per item (all camelCase)
  const results: BulkUpsertResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const mainPk = pkRows[i]; // PK-only (already in camelCase field name since PK uses camelCase field)
    // pkRows entries come from SQL RETURNING or insertId — keys are DB column names.
    // For simple PK named the same in API and DB (like 'id') this is transparent.
    const result: BulkUpsertResult = { main: { [pk]: mainPk[pkCol] ?? mainPk[pk] } };

    // FK auto-fill: input camelCase + generated PK
    const mainForFK = { ...inputMains[i], [pk]: mainPk[pkCol] ?? mainPk[pk] };

    if (item.secondaries && Object.keys(item.secondaries).length > 0) {
      const sec = await processSecondaries(db, tableConf, dbTables, mainForFK, item.secondaries);
      if (Object.keys(sec).length > 0) result.secondaries = sec;
    }

    if (item.deletions && Object.keys(item.deletions).length > 0) {
      const del = await processDeletions(db, tableConf, item.deletions);
      if (Object.keys(del).length > 0) result.deletions = del;
    }

    // 6. afterInsert hook per item (camelCase)
    if (tableConf.afterInsert) {
      await tableConf.afterInsert(db, request, mainForFK as Parameters<NonNullable<typeof tableConf.afterInsert>>[2], result.secondaries);
    }

    results.push(result);
  }

  return results;
}
