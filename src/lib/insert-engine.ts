import { camelcaseObject, snakecaseRecord } from './naming.js';
import type { QueryClient } from './db.js';
import type {
  InsertParams,
  InsertResult,
  ITable,
  DbTables,
  JoinDefinition,
  DbRecord,
} from '../types.js';

function findWriteJoin(
  tableConf: ITable,
  joinTableName: string
): JoinDefinition | undefined {
  return tableConf.allowedWriteJoins?.find(
    ([joinSchema]) => joinSchema.tableName === joinTableName
  );
}

function removeExcludedFields(
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

function findSecondaryTableConf(
  dbTables: DbTables,
  joinTableName: string
): ITable | undefined {
  for (const [, conf] of Object.entries(dbTables)) {
    if (conf.Schema.tableName === joinTableName) return conf;
  }
  return undefined;
}

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
    secondaryResults = {};

    for (const [joinTableName, records] of Object.entries(secondaries)) {
      if (!records?.length) continue;

      const joinDef = findWriteJoin(tableConf, joinTableName);
      if (!joinDef) continue;

      const [joinSchema, joinField, mainField] = joinDef;
      const joinCol = joinSchema.col(joinField);
      const secondaryTableConf = findSecondaryTableConf(dbTables, joinTableName);

      // Prepare records: snakecase, auto-fill FK, remove excluded
      const preparedRecords = records.map((rec) => {
        let prepared = snakecaseRecord(rec);

        // Auto-fill FK from main inserted record
        const mainValue = Array.isArray(mainField)
          ? mainInserted[mainField[0]]
          : mainInserted[mainField as string];
        prepared[joinCol] = mainValue;

        // Remove excluded fields
        if (secondaryTableConf) {
          prepared = removeExcludedFields(prepared, secondaryTableConf);
        }

        return prepared;
      });

      // Insert or upsert
      const secondaryUpsertKeys = tableConf.upsertMap?.get(joinSchema);
      let insertedRows: Record<string, unknown>[];

      if (secondaryUpsertKeys) {
        const conflictCols = secondaryUpsertKeys.map((k) => joinSchema.col(k));
        insertedRows = await db.bulkInsertOrUpdate(
          joinSchema.tableName,
          preparedRecords as DbRecord[],
          conflictCols
        );
      } else {
        insertedRows = await db.bulkInsert(
          joinSchema.tableName,
          preparedRecords as DbRecord[]
        );
      }

      secondaryResults[joinTableName] = insertedRows.map((r) =>
        camelcaseObject(r as Record<string, unknown>)
      );
    }
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
