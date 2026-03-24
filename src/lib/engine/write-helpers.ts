import { camelcaseObject, snakecaseRecord } from '../naming.js';
import type { QueryClient } from '../db.js';
import type {
  ITable,
  DbTables,
  JoinDefinition,
  DbRecord,
} from '../../types.js';

export function findWriteJoin(
  tableConf: ITable,
  joinTableName: string
): JoinDefinition | undefined {
  return tableConf.allowedWriteJoins?.find(
    ([joinSchema]) => joinSchema.tableName === joinTableName
  );
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

export async function processSecondaries(
  db: QueryClient,
  tableConf: ITable,
  dbTables: DbTables,
  mainRecord: Record<string, unknown>,
  secondaries: Record<string, Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};

  for (const [joinTableName, records] of Object.entries(secondaries)) {
    if (!records?.length) continue;

    const joinDef = findWriteJoin(tableConf, joinTableName);
    if (!joinDef) continue;

    const [joinSchema, joinField, mainField] = joinDef;
    const joinCol = joinSchema.col(joinField);
    const secondaryTableConf = findSecondaryTableConf(dbTables, joinTableName);
    const secondaryPk = secondaryTableConf?.primary || joinField;
    const secondaryPkCol = Array.isArray(secondaryPk)
      ? secondaryPk.map((f) => joinSchema.col(f))
      : joinSchema.col(secondaryPk);

    const preparedRecords = records.map((rec) => {
      let prepared = snakecaseRecord(rec);

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

    results[joinTableName] = pkRows.map((r) =>
      camelcaseObject(r as Record<string, unknown>)
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

  for (const [joinTableName, records] of Object.entries(deletions)) {
    if (!records?.length) continue;

    const joinDef = findWriteJoin(tableConf, joinTableName);
    if (!joinDef) continue;

    const [joinSchema] = joinDef;
    const deletedRows: Record<string, unknown>[] = [];

    for (const rec of records) {
      const snaked = snakecaseRecord(rec) as DbRecord;
      const affectedRows = await db.delete(joinSchema.tableName, snaked);
      if (affectedRows > 0) {
        deletedRows.push(camelcaseObject(snaked as Record<string, unknown>));
      }
    }

    results[joinTableName] = deletedRows;
  }

  return results;
}
