import { camelcaseObject, snakecaseRecord } from '../naming.js';
import { escapeIdent } from '../db.js';
import { processSecondaries, processDeletions } from './write-helpers.js';
import { stripTenantColumn, buildTenantWhere, buildTenantJoin } from '../tenant.js';
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
      const tw = buildTenantWhere(scope, tenant.ids, 2);
      const joinSql = buildTenantJoin(scope, tableName);
      const checkSql = `SELECT 1 FROM "${escapeIdent(tableName)}" ${joinSql} WHERE "${escapeIdent(tableName)}"."${escapeIdent(pkCol)}" = $1 AND ${tw.sql} LIMIT 1`;
      const checkResult = await db.query(checkSql, [pkValue, ...tw.values]);
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

  // 3. Update main (or fetch if no fields to update)
  let mainUpdated: Record<string, unknown>;
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
    const rows = await db.update(
      tableConf.Schema.tableName,
      updateFields as DbRecord,
      { [pkCol]: pkValue } as DbRecord,
      extraCondition
    );

    if (rows.length === 0) {
      const error = new Error(`Record not found`) as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }

    mainUpdated = camelcaseObject(rows[0] as Record<string, unknown>);
  } else {
    // No fields to update: fetch the existing record (for secondaries/deletions)
    let whereSql = `"${escapeIdent(tableConf.Schema.tableName)}"."${escapeIdent(pkCol)}" = $1`;
    const whereValues: unknown[] = [pkValue];

    if (extraCondition) {
      whereSql += ` AND ${extraCondition.build(2, (i) => `$${i}`)}`;
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

    mainUpdated = camelcaseObject(rows[0]);
  }

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
