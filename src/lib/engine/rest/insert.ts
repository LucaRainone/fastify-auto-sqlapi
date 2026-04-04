import { camelcaseObject, snakecaseRecord } from '../../naming.js';
import { removeExcludedFields, processSecondaries } from '../write-helpers.js';
import { injectTenantValue, validateTenantFK } from '../../tenant.js';
import { runValidation } from '../validate.js';
import { primaryAsString } from '../../../types.js';
import type {
  InsertParams,
  InsertResult,
  DbRecord,
  TenantScopeIndirect,
} from '../../../types.js';

export async function insertEngine(params: InsertParams): Promise<InsertResult> {
  const { db, tableConf, dbTables, request, record, secondaries, tenant } = params;

  const pk = primaryAsString(tableConf.primary);
  const pkCol = tableConf.Schema.col(pk);

  // 1. Prepare main record
  let mainRecord = snakecaseRecord(record);
  mainRecord = removeExcludedFields(mainRecord, tableConf);

  // 1b. Tenant: inject or validate
  if (tenant) {
    if ('through' in tenant.scope) {
      // Indirect: validate FK belongs to tenant
      const scope = tenant.scope as TenantScopeIndirect;
      const fkCol = scope.through.localField;
      const fkValue = mainRecord[fkCol];
      await validateTenantFK(db, scope, tenant.ids, [fkValue]);
    } else {
      injectTenantValue(mainRecord, tenant.scope, tenant.ids);
    }
  }

  // 2. Custom validation (receives original camelCase record)
  await runValidation(db, request, tableConf, record, secondaries);

  // 3. beforeInsert hook
  if (tableConf.beforeInsert) {
    await tableConf.beforeInsert(db, request, mainRecord);
  }

  // 4. Insert main → returns PK-only
  let pkResult: Record<string, unknown>;
  const upsertKeys = tableConf.upsertMap?.get(tableConf.Schema);
  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => tableConf.Schema.col(k));
    pkResult = await db.insertOrUpdate(
      tableConf.Schema.tableName,
      mainRecord as DbRecord,
      conflictCols,
      pkCol
    );
  } else {
    pkResult = await db.insert(
      tableConf.Schema.tableName,
      mainRecord as DbRecord,
      pkCol
    );
  }

  const mainPkCamel = camelcaseObject(pkResult);

  // 5. Secondaries: need full record for FK auto-fill
  let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
  if (secondaries && Object.keys(secondaries).length > 0) {
    // Merge input record + PK for FK auto-fill
    const mainForFK = { ...camelcaseObject(mainRecord as Record<string, unknown>), ...mainPkCamel };
    secondaryResults = await processSecondaries(db, tableConf, dbTables, mainForFK, secondaries);
  }

  // 6. afterInsert hook
  if (tableConf.afterInsert) {
    const mainForHook = { ...camelcaseObject(mainRecord as Record<string, unknown>), ...mainPkCamel };
    await tableConf.afterInsert(db, request, mainForHook, secondaryResults);
  }

  // 7. Return PK-only
  const result: InsertResult = { main: mainPkCamel };
  if (secondaryResults && Object.keys(secondaryResults).length > 0) {
    result.secondaries = secondaryResults;
  }

  return result;
}
