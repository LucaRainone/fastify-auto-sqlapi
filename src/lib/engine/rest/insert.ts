import { camelcaseObject } from '../../naming.js';
import { processSecondaries, prepareInsertRecord, assertUpsertKeys } from '../write-helpers.js';
import { enforceTenantOnWrites, assertTenantOwnsConflicts } from '../../tenant.js';
import { primaryAsCols } from '../../../types.js';
import type {
  InsertParams,
  InsertResult,
  DbRecord,
  RowsByAlias,
  WrittenRow,
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
  // main insert too. An adapter without connect() cannot run this at all (ADR 0023).
  return db.withTransaction(async (tx) => {
    // 2. Tenant: inject (direct) or validate FK (indirect) — enforced after user mutations
    await enforceTenantOnWrites(tx, tenant, [mainRecord]);

    // 3. Insert main → its PK, and what the statement did to the row
    let written: WrittenRow;
    const upsertKeys = tableConf.upsertMap?.get(schema);
    if (upsertKeys) {
      const conflictCols = upsertKeys.map((k) => schema.col(k));
      assertUpsertKeys(schema, conflictCols, [pkCol].flat(), [mainRecord]);
      // Tenant isolation: a conflicting upsert must not overwrite a row owned by another tenant.
      await assertTenantOwnsConflicts(tx, tenant, schema.tableName, conflictCols, [mainRecord]);
      written = await tx.insertOrUpdateWithAction(
        schema.tableName,
        mainRecord as DbRecord,
        conflictCols,
        pkCol
      );
    } else {
      const pk = await tx.insert(schema.tableName, mainRecord as DbRecord, pkCol);
      written = { pk, action: 'inserted' };
    }

    const mainPkCamel = camelcaseObject(written.pk, schema);

    // 4. Secondaries: need full record for FK auto-fill (camelCase)
    let secondaryResults: RowsByAlias | undefined;
    if (secondaries && Object.keys(secondaries).length > 0) {
      const mainForFK = { ...inputRecord, ...mainPkCamel };
      secondaryResults = await processSecondaries(
        { db: tx, tableConf, dbTables, mainRecord: mainForFK, tenant, request }, secondaries
      );
    }

    // 5. afterInsert hook (camelCase — input merged with generated PK)
    if (tableConf.afterInsert) {
      const mainForHook = { ...inputRecord, ...mainPkCamel };
      await tableConf.afterInsert({ db: tx, req: request, record: mainForHook, secondaries: secondaryResults });
    }

    // 6. Return the PK and the action
    const result: InsertResult = { main: mainPkCamel, action: written.action };
    if (secondaryResults && Object.keys(secondaryResults).length > 0) {
      result.secondaries = secondaryResults;
    }

    return result;
  });
}
