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

  const schema = tableConf.Schema;
  const pk = primaryAsString(tableConf.primary);
  const pkCol = schema.col(pk);

  // 1. Mutable copy of input in camelCase (user-facing format)
  const inputRecord: Record<string, unknown> = { ...record };

  // 2. Custom validation (camelCase)
  await runValidation(db, request, tableConf, inputRecord, secondaries);

  // 3. beforeInsert hook (camelCase — user can mutate with schema field names)
  if (tableConf.beforeInsert) {
    await tableConf.beforeInsert(db, request, inputRecord as Parameters<NonNullable<typeof tableConf.beforeInsert>>[2]);
  }

  // 4. Convert to DB format (after all user mutations)
  let mainRecord = snakecaseRecord(inputRecord, schema);
  mainRecord = removeExcludedFields(mainRecord, tableConf);

  // 5. Tenant: inject or validate (enforced after user mutations for security)
  if (tenant) {
    if ('through' in tenant.scope) {
      const scope = tenant.scope as TenantScopeIndirect;
      const fkCol = scope.through.localField;
      const fkValue = mainRecord[fkCol];
      await validateTenantFK(db, scope, tenant.ids, [fkValue]);
    } else {
      injectTenantValue(mainRecord, tenant.scope, tenant.ids);
    }
  }

  // 6. Insert main → returns PK-only
  let pkResult: Record<string, unknown>;
  const upsertKeys = tableConf.upsertMap?.get(schema);
  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => schema.col(k));
    pkResult = await db.insertOrUpdate(
      schema.tableName,
      mainRecord as DbRecord,
      conflictCols,
      pkCol
    );
  } else {
    pkResult = await db.insert(
      schema.tableName,
      mainRecord as DbRecord,
      pkCol
    );
  }

  const mainPkCamel = camelcaseObject(pkResult, schema);

  // 7. Secondaries: need full record for FK auto-fill (camelCase)
  let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
  if (secondaries && Object.keys(secondaries).length > 0) {
    const mainForFK = { ...inputRecord, ...mainPkCamel };
    secondaryResults = await processSecondaries(db, tableConf, dbTables, mainForFK, secondaries);
  }

  // 8. afterInsert hook (camelCase — input merged with generated PK)
  if (tableConf.afterInsert) {
    const mainForHook = { ...inputRecord, ...mainPkCamel };
    await tableConf.afterInsert(db, request, mainForHook as Parameters<NonNullable<typeof tableConf.afterInsert>>[2], secondaryResults);
  }

  // 9. Return PK-only
  const result: InsertResult = { main: mainPkCamel };
  if (secondaryResults && Object.keys(secondaryResults).length > 0) {
    result.secondaries = secondaryResults;
  }

  return result;
}
