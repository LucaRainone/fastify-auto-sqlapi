import { snakecaseRecord } from '../../naming.js';
import { processSecondaries, processDeletions } from '../write-helpers.js';
import {
  stripTenantColumn,
  assertTenantOwnership,
  buildTenantUpdateExtra,
  enforceTenantFKOnUpdate,
} from '../../tenant.js';
import { runValidation } from '../validate.js';
import { httpError } from '../../errors.js';
import { type ConditionValue } from 'node-condition-builder';
import type {
  UpdateParams,
  UpdateResult,
  DbRecord,
} from '../../../types.js';

export async function updateEngine(params: UpdateParams): Promise<UpdateResult> {
  const { db, tableConf, dbTables, request, record, secondaries, deletions, tenant } = params;

  const schema = tableConf.Schema;
  // Every primary key field/column: composite PKs must match on ALL columns, otherwise an
  // UPDATE keyed on the first column alone would hit every row sharing that value.
  const pkFields = Array.isArray(tableConf.primary) ? tableConf.primary : [tableConf.primary];
  const pkCols = pkFields.map((f) => schema.col(f));
  const pkValues = pkFields.map((f) => record[f]);

  const missingIdx = pkValues.findIndex((v) => v == null);
  if (missingIdx !== -1) throw httpError(400, `Primary key "${pkFields[missingIdx]}" is required`);

  // 1. Tenant ownership check (indirect) — do it early so user mutations don't run on records they can't access
  await assertTenantOwnership(db, tenant, schema.tableName, pkCols, pkValues as ConditionValue[]);

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
  for (const c of pkCols) delete updateFields[c];

  // 6. Strip tenant column (user cannot change tenant of an existing record).
  //    For indirect scopes the tenant link is the through-FK (localField): it may be changed,
  //    but only to another value the caller owns — re-validate the new FK against the tenant.
  if (tenant) {
    stripTenantColumn(updateFields, tenant.scope);
    await enforceTenantFKOnUpdate(db, tenant, updateFields);
  }

  // Steps 7-9 are atomic: a failure in secondaries or deletions rolls back the main
  // update too. Degrades to non-transactional when the adapter has no connect().
  return db.withTransaction(async (tx) => {
    // 7. Update main
    const hasFieldsToUpdate = Object.keys(updateFields).length > 0;

    const extraCondition = buildTenantUpdateExtra(tx, tenant);

    // WHERE matching every primary key column (single or composite).
    const whereByPk = Object.fromEntries(pkCols.map((c, i) => [c, pkValues[i]])) as DbRecord;

    if (hasFieldsToUpdate) {
      const affectedRows = await tx.update(
        schema.tableName,
        updateFields as DbRecord,
        whereByPk,
        extraCondition
      );

      if (affectedRows === 0) throw httpError(404, `Record not found`);
    } else {
      // No fields to update: verify the record exists (for secondaries/deletions)
      const whereParts = pkCols.map((c, i) => `${tx.qi(schema.tableName)}.${tx.qi(c)} = ${tx.ph(i + 1)}`);
      let whereSql = whereParts.join(' AND ');
      const whereValues: unknown[] = [...pkValues];

      if (extraCondition) {
        whereSql += ` AND ${extraCondition.build(pkCols.length + 1, tx.ph)}`;
        whereValues.push(...extraCondition.getValues());
      }

      const rows = await tx.select<Record<string, unknown>>({
        tableName: schema.tableName,
        where: whereSql,
        values: whereValues,
        limit: '1',
      });

      if (rows.length === 0) throw httpError(404, `Record not found`);
    }

    // Build the main response (PK-only — every PK field)
    const mainResult = Object.fromEntries(pkFields.map((f, i) => [f, pkValues[i]]));

    // 8. Secondaries (upsert/insert with FK auto-fill — camelCase)
    let secondaryResults: Record<string, Record<string, unknown>[]> | undefined;
    if (secondaries && Object.keys(secondaries).length > 0) {
      const mainForFK = { ...inputRecord };
      secondaryResults = await processSecondaries(tx, tableConf, dbTables, mainForFK, secondaries);
    }

    // 9. Deletions (FK auto-fill from main like secondaries)
    let deletionResults: Record<string, Record<string, unknown>[]> | undefined;
    if (deletions && Object.keys(deletions).length > 0) {
      const mainForFK = { ...inputRecord };
      deletionResults = await processDeletions(tx, tableConf, mainForFK, deletions);
    }

    // 10. afterUpdate hook (inside the transaction: throwing rolls everything back)
    if (tableConf.afterUpdate) {
      await tableConf.afterUpdate(
        tx,
        request,
        inputRecord as Parameters<NonNullable<typeof tableConf.afterUpdate>>[2],
        secondaryResults,
        deletionResults
      );
    }

    // 11. Return PK-only
    const result: UpdateResult = { main: mainResult };
    if (secondaryResults && Object.keys(secondaryResults).length > 0) {
      result.secondaries = secondaryResults;
    }
    if (deletionResults && Object.keys(deletionResults).length > 0) {
      result.deletions = deletionResults;
    }

    return result;
  });
}
