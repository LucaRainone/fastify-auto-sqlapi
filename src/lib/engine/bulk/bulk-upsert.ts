import { snakecaseRecord } from '../../naming.js';
import { removeExcludedFields, processSecondaries, processDeletions } from '../write-helpers.js';
import { injectTenantValue, validateTenantFK } from '../../tenant.js';
import { runValidation, runBulkValidation } from '../validate.js';
import { primaryAsString } from '../../../types.js';
import type {
  BulkUpsertParams,
  BulkUpsertResult,
  DbRecord,
  TenantScopeIndirect,
} from '../../../types.js';

export async function bulkUpsertEngine(params: BulkUpsertParams): Promise<BulkUpsertResult[]> {
  const { db, tableConf, dbTables, request, items, tenant } = params;
  if (!items.length) return [];

  const schema = tableConf.Schema;
  const pk = primaryAsString(tableConf.primary);
  const pkCol = schema.col(pk);

  // 1. Mutable camelCase copies of each item.main
  const inputMains: Record<string, unknown>[] = items.map((item) => ({ ...item.main }));

  // 2. Custom validation (camelCase)
  if (tableConf.validateBulk) {
    await runBulkValidation(db, request, tableConf, items);
  } else {
    for (let i = 0; i < items.length; i++) {
      await runValidation(db, request, tableConf, inputMains[i], items[i].secondaries);
    }
  }

  // 3. beforeInsert hook per record (camelCase)
  if (tableConf.beforeInsert) {
    for (const rec of inputMains) {
      await tableConf.beforeInsert(db, request, rec as Parameters<NonNullable<typeof tableConf.beforeInsert>>[2]);
    }
  }

  // 4. Convert to DB format (after user mutations)
  const preparedMains = inputMains.map((rec) => {
    let converted = snakecaseRecord(rec, schema);
    converted = removeExcludedFields(converted, tableConf);
    return converted as DbRecord;
  });

  // 5. Tenant: inject or validate FK (enforced after user mutations)
  if (tenant) {
    if ('through' in tenant.scope) {
      const scope = tenant.scope as TenantScopeIndirect;
      const fkCol = scope.through.localField;
      const fkValues = preparedMains.map((rec) => rec[fkCol]);
      await validateTenantFK(db, scope, tenant.ids, fkValues as unknown[]);
    } else {
      for (const rec of preparedMains) {
        injectTenantValue(rec as Record<string, unknown>, tenant.scope, tenant.ids);
      }
    }
  }

  // 6. Bulk upsert all mains in one query → returns PK-only
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

  // 7. Process secondaries, deletions, afterInsert per item (all camelCase)
  const results: BulkUpsertResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const mainPk = pkRows[i]; // PK-only (already in camelCase field name since PK uses camelCase field)
    // pkRows entries come from SQL RETURNING or insertId — keys are DB column names.
    // For simple PK named the same in API and DB (like 'id') this is transparent.
    // If PK name differs (rare), the user should not rely on mainPk for FK auto-fill — it's the merged inputMain that drives FK.
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

    // 8. afterInsert hook per item (camelCase)
    if (tableConf.afterInsert) {
      await tableConf.afterInsert(db, request, mainForFK as Parameters<NonNullable<typeof tableConf.afterInsert>>[2], result.secondaries);
    }

    results.push(result);
  }

  return results;
}
