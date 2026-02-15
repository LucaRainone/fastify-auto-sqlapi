import { camelcaseObject, snakecaseRecord } from '../naming.js';
import { removeExcludedFields, processSecondaries } from './write-helpers.js';
import type {
  InsertParams,
  InsertResult,
  DbRecord,
} from '../../types.js';

export async function insertEngine(params: InsertParams): Promise<InsertResult> {
  const { db, tableConf, dbTables, request, record, secondaries } = params;

  // 1. Prepare main record
  let mainRecord = snakecaseRecord(record);
  mainRecord = removeExcludedFields(mainRecord, tableConf);

  // 2. beforeInsert hook
  if (tableConf.beforeInsert) {
    await tableConf.beforeInsert(db, request, mainRecord);
  }

  // 3. Insert main
  let mainInserted: Record<string, unknown>;
  const upsertKeys = tableConf.upsertMap?.get(tableConf.Schema);
  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => tableConf.Schema.col(k));
    mainInserted = await db.insertOrUpdate(
      tableConf.Schema.tableName,
      mainRecord as DbRecord,
      conflictCols
    );
  } else {
    mainInserted = await db.insert(
      tableConf.Schema.tableName,
      mainRecord as DbRecord
    );
  }
  mainInserted = camelcaseObject(mainInserted as Record<string, unknown>);

  // 4. Secondaries
  let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
  if (secondaries && Object.keys(secondaries).length > 0) {
    secondaryResults = await processSecondaries(db, tableConf, dbTables, mainInserted, secondaries);
  }

  // 5. afterInsert hook
  if (tableConf.afterInsert) {
    await tableConf.afterInsert(db, request, mainInserted, secondaryResults);
  }

  // 6. Return
  const result: InsertResult = { main: mainInserted };
  if (secondaryResults && Object.keys(secondaryResults).length > 0) {
    result.secondaries = secondaryResults;
  }

  return result;
}
