import { camelcaseObject, snakecaseRecord } from '../naming.js';
import { processSecondaries, processDeletions } from './write-helpers.js';
import { stripTenantColumn, buildTenantCondition, buildTenantJoin } from '../tenant.js';
import { ConditionBuilder } from 'node-condition-builder';
import type {
  UpdateParams,
  UpdateResult,
  DbRecord,
  TenantScopeIndirect,
} from '../../types.js';

export async function updateEngine(params: UpdateParams): Promise<UpdateResult> {
  const { db, tableConf, dbTables, request, record, secondaries, deletions, tenant } = params;

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

  // 1b. Tenant: strip tenant column from update fields + validate ownership
  if (tenant) {
    stripTenantColumn(updateFields, tenant.scope);

    if ('through' in tenant.scope) {
      // Indirect: verify the record belongs to tenant via subquery
      const scope = tenant.scope as TenantScopeIndirect;
      const tableName = tableConf.Schema.tableName;
      const cb = new ConditionBuilder('AND');
      cb.isEqual(`${db.qi(tableName)}.${db.qi(pkCol)}`, pkValue);
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
  }

  // 2. beforeUpdate hook
  if (tableConf.beforeUpdate) {
    await tableConf.beforeUpdate(db, request, updateFields);
  }

  // 3. Update main
  const hasFieldsToUpdate = Object.keys(updateFields).length > 0;

  let extraCondition: ConditionBuilder | undefined;
  if (tenant && !('through' in tenant.scope)) {
    // Direct: add tenant to WHERE
    extraCondition = new ConditionBuilder('AND');
    if (tenant.ids.length === 1) {
      extraCondition.isEqual(tenant.scope.column, tenant.ids[0]);
    } else {
      extraCondition.isIn(tenant.scope.column, tenant.ids);
    }
  }

  if (hasFieldsToUpdate) {
    const affectedRows = await db.update(
      tableConf.Schema.tableName,
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
    let whereSql = `${db.qi(tableConf.Schema.tableName)}.${db.qi(pkCol)} = ${db.ph(1)}`;
    const whereValues: unknown[] = [pkValue];

    if (extraCondition) {
      whereSql += ` AND ${extraCondition.build(2, db.ph)}`;
      whereValues.push(...extraCondition.getValues());
    }

    const rows = await db.select<Record<string, unknown>>({
      tableName: tableConf.Schema.tableName,
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

  // 4. Secondaries (upsert/insert with FK auto-fill)
  let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
  if (secondaries && Object.keys(secondaries).length > 0) {
    // Merge input fields + PK for FK auto-fill
    const mainForFK = { ...camelcaseObject(snaked as Record<string, unknown>) };
    secondaryResults = await processSecondaries(db, tableConf, dbTables, mainForFK, secondaries);
  }

  // 5. Deletions
  let deletionResults: Record<string, Record<string, unknown>[]> | undefined;
  if (deletions && Object.keys(deletions).length > 0) {
    deletionResults = await processDeletions(db, tableConf, deletions);
  }

  // 6. Return PK-only
  const result: UpdateResult = { main: mainResult };
  if (secondaryResults && Object.keys(secondaryResults).length > 0) {
    result.secondaries = secondaryResults;
  }
  if (deletionResults && Object.keys(deletionResults).length > 0) {
    result.deletions = deletionResults;
  }

  return result;
}
