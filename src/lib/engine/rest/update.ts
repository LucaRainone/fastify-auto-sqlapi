import { snakecaseRecord } from '../../naming.js';
import { processSecondaries, processDeletions } from '../write-helpers.js';
import { stripTenantColumn, buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import { runValidation } from '../validate.js';
import { ConditionBuilder, type ConditionValue } from 'node-condition-builder';
import { primaryAsString } from '../../../types.js';
import type {
  UpdateParams,
  UpdateResult,
  DbRecord,
  TenantScopeIndirect,
} from '../../../types.js';

export async function updateEngine(params: UpdateParams): Promise<UpdateResult> {
  const { db, tableConf, dbTables, request, record, secondaries, deletions, tenant } = params;

  const schema = tableConf.Schema;
  const pk = primaryAsString(tableConf.primary);
  const pkCol = schema.col(pk);
  const pkValue = record[pk];

  if (pkValue == null) {
    const error = new Error(`Primary key "${pk}" is required`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }

  // 1. Tenant ownership check (indirect) — do it early so user mutations don't run on records they can't access
  if (tenant && 'through' in tenant.scope) {
    const scope = tenant.scope as TenantScopeIndirect;
    const tableName = schema.tableName;
    const cb = new ConditionBuilder('AND');
    cb.isEqual(`${db.qi(tableName)}.${db.qi(pkCol)}`, pkValue as ConditionValue);
    cb.append(buildTenantCondition(db, scope, tenant.ids));
    const checkWhere = cb.build(1, db.ph);
    const checkValues = cb.getValues();
    const joinSql = buildTenantJoin(db, scope, tableName);
    const checkSql = `SELECT 1 FROM ${db.qi(tableName)} ${joinSql} WHERE ${checkWhere} LIMIT 1`;
    const checkResult = await db.query(checkSql, checkValues);
    if (checkResult.rows.length === 0) {
      const error = new Error('Record not found') as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
  }

  // 2. Mutable copy of input in camelCase
  const inputRecord: Record<string, unknown> = { ...record };

  // 3. Custom validation (camelCase)
  await runValidation(db, request, tableConf, inputRecord, secondaries);

  // 4. beforeUpdate hook (camelCase — user can mutate with schema field names)
  if (tableConf.beforeUpdate) {
    await tableConf.beforeUpdate(db, request, inputRecord as Parameters<NonNullable<typeof tableConf.beforeUpdate>>[2]);
  }

  // 5. Convert to DB format (after all user mutations)
  const snaked = snakecaseRecord(inputRecord, schema);
  const updateFields = { ...snaked };
  delete updateFields[pkCol];

  // 6. Strip tenant column (user cannot change tenant of an existing record)
  if (tenant) {
    stripTenantColumn(updateFields, tenant.scope);
  }

  // 7. Update main
  const hasFieldsToUpdate = Object.keys(updateFields).length > 0;

  let extraCondition: ConditionBuilder | undefined;
  if (tenant && !('through' in tenant.scope)) {
    extraCondition = new ConditionBuilder('AND');
    if (tenant.ids.length === 1) {
      extraCondition.isEqual(tenant.scope.column, tenant.ids[0]);
    } else {
      extraCondition.isIn(tenant.scope.column, tenant.ids);
    }
  }

  if (hasFieldsToUpdate) {
    const affectedRows = await db.update(
      schema.tableName,
      updateFields as DbRecord,
      { [pkCol]: pkValue } as DbRecord,
      extraCondition
    );

    if (affectedRows === 0) {
      const error = new Error(`Record not found`) as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
  } else {
    // No fields to update: verify the record exists (for secondaries/deletions)
    let whereSql = `${db.qi(schema.tableName)}.${db.qi(pkCol)} = ${db.ph(1)}`;
    const whereValues: unknown[] = [pkValue];

    if (extraCondition) {
      whereSql += ` AND ${extraCondition.build(2, db.ph)}`;
      whereValues.push(...extraCondition.getValues());
    }

    const rows = await db.select<Record<string, unknown>>({
      tableName: schema.tableName,
      where: whereSql,
      values: whereValues,
      limit: '1',
    });

    if (rows.length === 0) {
      const error = new Error(`Record not found`) as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
  }

  // Build the main response (PK-only)
  const mainResult = { [pk]: pkValue };

  // 8. Secondaries (upsert/insert with FK auto-fill — camelCase)
  let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
  if (secondaries && Object.keys(secondaries).length > 0) {
    const mainForFK = { ...inputRecord };
    secondaryResults = await processSecondaries(db, tableConf, dbTables, mainForFK, secondaries);
  }

  // 9. Deletions
  let deletionResults: Record<string, Record<string, unknown>[]> | undefined;
  if (deletions && Object.keys(deletions).length > 0) {
    deletionResults = await processDeletions(db, tableConf, deletions);
  }

  // 10. Return PK-only
  const result: UpdateResult = { main: mainResult };
  if (secondaryResults && Object.keys(secondaryResults).length > 0) {
    result.secondaries = secondaryResults;
  }
  if (deletionResults && Object.keys(deletionResults).length > 0) {
    result.deletions = deletionResults;
  }

  return result;
}
