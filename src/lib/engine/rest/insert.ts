import { camelcaseObject } from '../../naming.js';
import { processSecondaries, prepareInsertRecord } from '../write-helpers.js';
import { enforceTenantOnWrites, assertTenantOwnsConflicts } from '../../tenant.js';
import { primaryAsCols } from '../../../types.js';
import type {
  InsertParams,
  InsertResult,
  DbRecord,
} from '../../../types.js';

export async function insertEngine(params: InsertParams): Promise<InsertResult> {
  const { db, tableConf, dbTables, request, record, secondaries, tenant } = params;

  const schema = tableConf.Schema;
  // Full primary key columns (composite PKs need every column for RETURNING /
  // mysql synthesis, otherwise the response is missing PK fields).
  const pkCol = primaryAsCols(tableConf.primary, (f) => schema.col(f));

  // 1. Validate, run beforeInsert hook, snakecase, drop excluded fields.
  const { camel: inputRecord, snake: mainRecord } = await prepareInsertRecord(
    { db, tableConf, request },
    record,
    secondaries,
  );

  // Steps 2-5 are atomic: a failure in secondaries or afterInsert rolls back the
  // main insert too. Degrades to non-transactional when the adapter has no connect().
  return db.withTransaction(async (tx) => {
    // 2. Tenant: inject (direct) or validate FK (indirect) — enforced after user mutations
    await enforceTenantOnWrites(tx, tenant, [mainRecord]);

    // 3. Insert main → returns PK-only
    let pkResult: Record<string, unknown>;
    const upsertKeys = tableConf.upsertMap?.get(schema);
    if (upsertKeys) {
      const conflictCols = upsertKeys.map((k) => schema.col(k));
      // Tenant isolation: a conflicting upsert must not overwrite a row owned by another tenant.
      await assertTenantOwnsConflicts(tx, tenant, schema.tableName, conflictCols, [mainRecord]);
      pkResult = await tx.insertOrUpdate(
        schema.tableName,
        mainRecord as DbRecord,
        conflictCols,
        pkCol
      );
    } else {
      pkResult = await tx.insert(
        schema.tableName,
        mainRecord as DbRecord,
        pkCol
      );
    }

    const mainPkCamel = camelcaseObject(pkResult, schema);

    // 4. Secondaries: need full record for FK auto-fill (camelCase)
    let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
    if (secondaries && Object.keys(secondaries).length > 0) {
      const mainForFK = { ...inputRecord, ...mainPkCamel };
      secondaryResults = await processSecondaries(tx, tableConf, dbTables, mainForFK, secondaries);
    }

    // 5. afterInsert hook (camelCase — input merged with generated PK)
    if (tableConf.afterInsert) {
      const mainForHook = { ...inputRecord, ...mainPkCamel };
      await tableConf.afterInsert(tx, request, mainForHook as Parameters<NonNullable<typeof tableConf.afterInsert>>[2], secondaryResults);
    }

    // 6. Return PK-only
    const result: InsertResult = { main: mainPkCamel };
    if (secondaryResults && Object.keys(secondaryResults).length > 0) {
      result.secondaries = secondaryResults;
    }

    return result;
  });
}
