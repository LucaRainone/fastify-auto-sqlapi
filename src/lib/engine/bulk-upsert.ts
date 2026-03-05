import { camelcaseObject, snakecaseRecord } from '../naming.js';
import { removeExcludedFields, processSecondaries, processDeletions } from './write-helpers.js';
import { injectTenantValue, validateTenantFK } from '../tenant.js';
import { primaryAsString } from '../../types.js';
import type {
  BulkUpsertParams,
  BulkUpsertResult,
  DbRecord,
  TenantScopeIndirect,
} from '../../types.js';

export async function bulkUpsertEngine(params: BulkUpsertParams): Promise<BulkUpsertResult[]> {
  const { db, tableConf, dbTables, request, items, tenant } = params;
  if (!items.length) return [];

  const pk = primaryAsString(tableConf.primary);
  const pkCol = tableConf.Schema.col(pk);

  // 1. Prepare all main records
  const preparedMains = items.map((item) => {
    let rec = snakecaseRecord(item.main);
    rec = removeExcludedFields(rec, tableConf);
    return rec as DbRecord;
  });

  // 1b. Tenant: inject or validate FK
  if (tenant) {
    if ('through' in tenant.scope) {
      // Indirect: collect all FK values, validate in batch
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

  // 2. beforeInsert hook per record
  if (tableConf.beforeInsert) {
    for (const rec of preparedMains) {
      await tableConf.beforeInsert(db, request, rec);
    }
  }

  // 3. Bulk upsert all mains in one query → returns PK-only
  const upsertKeys = tableConf.upsertMap?.get(tableConf.Schema);
  let pkRows: Record<string, unknown>[];
  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => tableConf.Schema.col(k));
    pkRows = await db.bulkInsertOrUpdate(
      tableConf.Schema.tableName,
      preparedMains,
      conflictCols,
      pkCol
    );
  } else {
    pkRows = await db.bulkInsert(
      tableConf.Schema.tableName,
      preparedMains,
      pkCol
    );
  }

  const pksCamel = pkRows.map((r) => camelcaseObject(r as Record<string, unknown>));

  // 4. Process secondaries and deletions per item
  const results: BulkUpsertResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const mainPk = pksCamel[i];
    const result: BulkUpsertResult = { main: mainPk };

    // For FK auto-fill in secondaries, merge input record + PK
    const mainForFK = { ...camelcaseObject(preparedMains[i] as Record<string, unknown>), ...mainPk };

    if (item.secondaries && Object.keys(item.secondaries).length > 0) {
      const sec = await processSecondaries(db, tableConf, dbTables, mainForFK, item.secondaries);
      if (Object.keys(sec).length > 0) result.secondaries = sec;
    }

    if (item.deletions && Object.keys(item.deletions).length > 0) {
      const del = await processDeletions(db, tableConf, item.deletions);
      if (Object.keys(del).length > 0) result.deletions = del;
    }

    // 5. afterInsert hook per item
    if (tableConf.afterInsert) {
      await tableConf.afterInsert(db, request, mainForFK, result.secondaries);
    }

    results.push(result);
  }

  return results;
}
