import { camelcaseObject, snakecaseRecord } from './naming.js';
import { processSecondaries, processDeletions } from './write-helpers.js';
import type {
  UpdateParams,
  UpdateResult,
  DbRecord,
} from '../types.js';

export async function updateEngine(params: UpdateParams): Promise<UpdateResult> {
  const { db, tableConf, dbTables, request, record, secondaries, deletions } = params;

  // 1. Prepare: extract PK, snakecase, build update fields
  const pk = tableConf.primary;
  const pkCol = tableConf.Schema.col(pk);
  const snaked = snakecaseRecord(record);
  const pkValue = snaked[pkCol];

  if (pkValue == null) {
    const error = new Error(`Primary key "${pk}" is required`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }

  const updateFields = { ...snaked };
  delete updateFields[pkCol];

  // 2. beforeUpdate hook
  if (tableConf.beforeUpdate) {
    await tableConf.beforeUpdate(db, request, updateFields);
  }

  // 3. Update main
  const rows = await db.update(
    tableConf.Schema.tableName,
    updateFields as DbRecord,
    { [pkCol]: pkValue } as DbRecord
  );

  if (rows.length === 0) {
    const error = new Error(`Record not found`) as Error & { statusCode: number };
    error.statusCode = 404;
    throw error;
  }

  const mainUpdated = camelcaseObject(rows[0] as Record<string, unknown>);

  // 4. Secondaries (upsert/insert with FK auto-fill)
  let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
  if (secondaries && Object.keys(secondaries).length > 0) {
    secondaryResults = await processSecondaries(db, tableConf, dbTables, mainUpdated, secondaries);
  }

  // 5. Deletions
  let deletionResults: Record<string, Record<string, unknown>[]> | undefined;
  if (deletions && Object.keys(deletions).length > 0) {
    deletionResults = await processDeletions(db, tableConf, deletions);
  }

  // 6. Return
  const result: UpdateResult = { main: mainUpdated };
  if (secondaryResults && Object.keys(secondaryResults).length > 0) {
    result.secondaries = secondaryResults;
  }
  if (deletionResults && Object.keys(deletionResults).length > 0) {
    result.deletions = deletionResults;
  }

  return result;
}
