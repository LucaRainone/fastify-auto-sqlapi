import { camelcaseObject, snakecaseRecord } from '../naming.js';
import { removeExcludedFields, processSecondaries, processDeletions } from './write-helpers.js';
import type {
  BulkUpsertParams,
  BulkUpsertResult,
  DbRecord,
} from '../../types.js';

export async function bulkUpsertEngine(params: BulkUpsertParams): Promise<BulkUpsertResult[]> {
  const { db, tableConf, dbTables, items } = params;
  if (!items.length) return [];

  // 1. Prepare all main records
  const preparedMains = items.map((item) => {
    let rec = snakecaseRecord(item.main);
    rec = removeExcludedFields(rec, tableConf);
    return rec as DbRecord;
  });

  // 2. Bulk upsert all mains in one query
  const upsertKeys = tableConf.upsertMap?.get(tableConf.Schema);
  let mainRows: Record<string, unknown>[];
  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => tableConf.Schema.col(k));
    mainRows = await db.bulkInsertOrUpdate(
      tableConf.Schema.tableName,
      preparedMains,
      conflictCols
    );
  } else {
    mainRows = await db.bulkInsert(
      tableConf.Schema.tableName,
      preparedMains
    );
  }

  const mainsCamel = mainRows.map((r) => camelcaseObject(r as Record<string, unknown>));

  // 3. Process secondaries and deletions per item
  const results: BulkUpsertResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const mainUpserted = mainsCamel[i];
    const result: BulkUpsertResult = { main: mainUpserted };

    if (item.secondaries && Object.keys(item.secondaries).length > 0) {
      const sec = await processSecondaries(db, tableConf, dbTables, mainUpserted, item.secondaries);
      if (Object.keys(sec).length > 0) result.secondaries = sec;
    }

    if (item.deletions && Object.keys(item.deletions).length > 0) {
      const del = await processDeletions(db, tableConf, item.deletions);
      if (Object.keys(del).length > 0) result.deletions = del;
    }

    results.push(result);
  }

  return results;
}
