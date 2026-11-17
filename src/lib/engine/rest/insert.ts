import { camelcaseObject } from '../../naming.js';
import {
  processSecondaries, prepareInsertRecord, assertUpsertKeys, assertWriteJoinAliases, hasAliases,
  assertExcludedKeysExist, insertExcludedKeyFields,
} from '../write-helpers.js';
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
  const { db, tableConf, dbTables, request, record, upsert, replace, tenant } = params;
  const children = { upsert, replace };

  const schema = tableConf.schema;
  // Full primary key columns (composite PKs need every column for RETURNING /
  // mysql synthesis, otherwise the response is missing PK fields).
  const pkCol = primaryAsCols(tableConf.primary, (f) => schema.col(f));

  assertWriteJoinAliases(tableConf, children);

  // 1. Validate, run beforeInsert hook, snakecase, drop excluded fields.
  const { camel: inputRecord, snake: mainRecord } = await prepareInsertRecord(
    { db, tableConf, dbTables, request },
    record,
    children,
  );

  // Steps 2-5 are atomic: a failure in the child rows or afterInsert rolls back the
  // main insert too. An adapter without connect() cannot run this at all (ADR 0023).
  return db.withTransaction(async (tx) => {
    // 2. Tenant: inject (direct) or validate FK (indirect) — enforced after user mutations
    await enforceTenantOnWrites(tx, tenant, [mainRecord]);

    // 3. Insert main → its PK, and what the statement did to the row
    let written: WrittenRow;
    const upsertKeys = tableConf.upsertKey;
    if (upsertKeys) {
      const conflictCols = upsertKeys.map((k) => schema.col(k));
      assertUpsertKeys(schema, conflictCols, [pkCol].flat(), [mainRecord]);
      await assertExcludedKeysExist(
        tx, schema, conflictCols, insertExcludedKeyFields(tableConf, upsertKeys), [mainRecord], [record],
        (_, field) => `main.${field}`
      );
      // Tenant isolation: a conflicting upsert must not overwrite a row owned by another tenant.
      await assertTenantOwnsConflicts(tx, tenant, schema.tableName, conflictCols, [mainRecord]);
      written = await tx.upsert(
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

    // 4. Child rows: need full record for FK auto-fill (camelCase). A `replace` also removes
    //    the child rows the request left out — an upserted main row may have some (ADR 0029).
    let secondaryResults: RowsByAlias | undefined;
    let deletionResults: RowsByAlias | undefined;
    if (hasAliases(upsert, replace)) {
      const mainForFK = { ...inputRecord, ...mainPkCamel };
      const outcome = await processSecondaries(
        { db: tx, tableConf, dbTables, mainRecord: mainForFK, tenant, request }, children
      );
      secondaryResults = outcome.written;
      if (Object.keys(outcome.removed).length > 0) deletionResults = outcome.removed;
    }

    // 5. afterInsert hook (camelCase — input merged with generated PK)
    if (tableConf.afterInsert) {
      const mainForHook = { ...inputRecord, ...mainPkCamel };
      await tableConf.afterInsert({
        db: tx, req: request, record: mainForHook, secondaries: secondaryResults, deletions: deletionResults,
      });
    }

    // 6. Return the PK and the action
    const result: InsertResult = { main: mainPkCamel, action: written.action };
    if (secondaryResults && Object.keys(secondaryResults).length > 0) {
      result.secondaries = secondaryResults;
    }
    if (deletionResults) result.deletions = deletionResults;

    return result;
  });
}
