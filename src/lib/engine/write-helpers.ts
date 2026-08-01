import type { FastifyRequest } from 'fastify';
import { camelcaseObject, snakecaseRecord } from '../naming.js';
import type { QueryClient } from '../db.js';
import { runValidation } from './validate.js';
import {
  tenantForTable,
  buildTenantRowGuard,
  enforceTenantOnWrites,
  assertTenantOwnsConflicts,
} from '../tenant.js';
import type {
  ITable,
  DbTables,
  JoinDefinition,
  DbRecord,
  TenantContext,
} from '../../types.js';

/**
 * Resolve the write join an alias names, or undefined when the table does not declare it.
 *
 * An undeclared alias is skipped rather than rejected: a table with no `allowedWriteJoins`
 * ignores any secondaries sent to it, which is the tested contract (see the "ignores
 * secondaries/deletions not in allowedWriteJoins" specs). The HTTP boundary is what fails
 * closed — the generated body schema declares `additionalProperties:false` on the alias
 * container, so a request naming an undeclared alias is a 400 before it reaches here.
 */
function findWriteJoin(
  tableConf: ITable,
  alias: string
): JoinDefinition | undefined {
  return tableConf.allowedWriteJoins?.find((j) => j.alias === alias);
}

/**
 * Drop `excludeFromCreation` columns from a snake_case (DB-format) record.
 *
 * Exclusion is a whitelist on CLIENT input: call this on the client payload only,
 * BEFORE any server-side value is assigned (beforeInsert mutations, FK auto-fill),
 * so engine/hook-generated values on those fields reach the SQL.
 */
function removeExcludedFields(
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

/**
 * Same whitelist as `removeExcludedFields`, but for a camelCase record (schema
 * field names) and in place. Used on the client payload before the beforeInsert
 * hook runs.
 */
function removeExcludedFieldsCamel(
  record: Record<string, unknown>,
  tableConf: ITable
): void {
  if (!tableConf.excludeFromCreation?.length) return;
  for (const field of tableConf.excludeFromCreation) {
    delete record[field];
  }
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

/**
 * The context a per-alias write pass runs in. Shared by `processSecondaries` and
 * `processDeletions`, which differ only in the payload they are handed.
 */
export interface WriteJoinPass {
  db: QueryClient;
  tableConf: ITable;
  dbTables: DbTables;
  /** Main record (camelCase), the source of the FK auto-filled into every child row. */
  mainRecord: Record<string, unknown>;
  tenant?: TenantContext;
}

/** Everything both `processSecondaries` and `processDeletions` need to write one alias. */
interface WriteJoinTarget {
  joinSchema: JoinDefinition['joinSchema'];
  /** Child column holding the FK back to the main row. */
  joinCol: string;
  /** Value that FK takes, read off the main record. */
  mainValue: unknown;
  childConf: ITable | undefined;
  /** The caller's tenant re-targeted onto the child table's own scope. */
  childTenant: TenantContext | undefined;
}

/**
 * Resolve one write-join alias: where the child's FK lives, what value it takes, and which
 * tenant scope applies to the child table.
 */
function resolveWriteJoinTarget(
  joinDef: JoinDefinition,
  dbTables: DbTables,
  mainRecord: Record<string, unknown>,
  tenant: TenantContext | undefined
): WriteJoinTarget {
  const { joinSchema, joinField, mainField } = joinDef;
  const childConf = findSecondaryTableConf(dbTables, joinSchema.tableName);
  return {
    joinSchema,
    joinCol: joinSchema.col(joinField),
    mainValue: Array.isArray(mainField) ? mainRecord[mainField[0]] : mainRecord[mainField],
    childConf,
    childTenant: tenantForTable(tenant, childConf),
  };
}

interface PrepareCtx {
  db: QueryClient;
  tableConf: ITable;
  request: FastifyRequest;
}

/**
 * Prepare a single record for INSERT/UPSERT:
 *   1. shallow camelCase copy of `input`
 *   2. runValidation (camelCase — sees the client payload as sent)
 *   3. drop excludeFromCreation fields (client-input whitelist; applied BEFORE the
 *      hook so values it assigns — e.g. a server-generated id — reach the INSERT)
 *   4. beforeInsert hook (caller can mutate the camelCase copy)
 *   5. snakecaseRecord → DB format
 *
 * Returns both `camel` (input + hook mutations, used for FK auto-fill / afterInsert) and
 * `snake` (DB-ready record). The original `input` is left intact.
 *
 * Pass `secondaries` so the validate hook receives them; pass undefined to skip
 * secondaries-aware validation (e.g. when a bulk-level validator already ran).
 */
export async function prepareInsertRecord(
  ctx: PrepareCtx,
  input: Record<string, unknown>,
  secondaries?: Record<string, Record<string, unknown>[]>,
  options?: { skipValidate?: boolean }
): Promise<{ camel: Record<string, unknown>; snake: Record<string, unknown> }> {
  const camel: Record<string, unknown> = { ...input };
  if (!options?.skipValidate) {
    await runValidation(ctx.db, ctx.request, ctx.tableConf, camel, secondaries);
  }
  removeExcludedFieldsCamel(camel, ctx.tableConf);
  if (ctx.tableConf.beforeInsert) {
    await ctx.tableConf.beforeInsert(
      ctx.db,
      ctx.request,
      camel
    );
  }
  const snake = snakecaseRecord(camel, ctx.tableConf.Schema);
  return { camel, snake };
}

/**
 * Run `writeAlias` once per alias of a write-join payload, handing it the resolved target for
 * that alias and collecting the rows it reports back.
 *
 * Empty lists are a no-op, and an alias the table does not declare as a write join is skipped:
 * rejecting it is the request schema's job (`additionalProperties:false` on the alias
 * container), because a table declaring no write joins must keep ignoring what it is sent.
 */
async function forEachWriteJoin(
  pass: WriteJoinPass,
  payload: Record<string, Record<string, unknown>[]>,
  writeAlias: (
    records: Record<string, unknown>[],
    target: WriteJoinTarget,
    joinDef: JoinDefinition
  ) => Promise<Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, records] of Object.entries(payload)) {
    if (!records?.length) continue;

    const joinDef = findWriteJoin(pass.tableConf, alias);
    if (!joinDef) continue;

    const target = resolveWriteJoinTarget(joinDef, pass.dbTables, pass.mainRecord, pass.tenant);
    results[alias] = await writeAlias(records, target, joinDef);
  }

  return results;
}

/**
 * Write the child rows a request sent alongside the main record, one bulk statement per alias.
 *
 * A secondary is a write like any other: the child table's own `tenantScope` is enforced on it
 * (`tenantForTable` re-targets the caller's tenant onto that table's scope). Without this the
 * client picks the child's tenant value, which lets it plant rows inside another tenant — and,
 * where the child is upserted, hijack one of that tenant's existing rows via the conflict key.
 */
export function processSecondaries(
  pass: WriteJoinPass,
  secondaries: Record<string, Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const { db, tableConf } = pass;

  return forEachWriteJoin(pass, secondaries, async (records, target, joinDef) => {
    const { joinSchema, joinCol, mainValue, childConf, childTenant } = target;

    const childPk = childConf?.primary || joinDef.joinField;
    const childPkCol = Array.isArray(childPk)
      ? childPk.map((f) => joinSchema.col(f))
      : joinSchema.col(childPk);

    const preparedRecords = records.map((rec) => {
      let prepared = snakecaseRecord(rec, joinSchema);

      // Remove excluded fields from the client payload BEFORE the FK auto-fill:
      // an excluded FK column must not strip the engine-injected value below.
      if (childConf) {
        prepared = removeExcludedFields(prepared, childConf);
      }

      prepared[joinCol] = mainValue;
      return prepared;
    });

    // Tenant enforcement runs after the FK auto-fill: for an indirect scope the through-FK
    // the engine just injected is the value being validated.
    await enforceTenantOnWrites(db, childTenant, preparedRecords);

    const upsertKeys = tableConf.upsertMap?.get(joinSchema);
    let pkRows: Record<string, unknown>[];

    if (upsertKeys) {
      const conflictCols = upsertKeys.map((k) => joinSchema.col(k));
      // A conflicting upsert must not overwrite — or re-parent — a child row owned by
      // another tenant, which the ON CONFLICT key alone would happily match.
      await assertTenantOwnsConflicts(
        db, childTenant, joinSchema.tableName, conflictCols, preparedRecords
      );
      pkRows = await db.bulkInsertOrUpdate(
        joinSchema.tableName, preparedRecords as DbRecord[], conflictCols, childPkCol
      );
    } else {
      pkRows = await db.bulkInsert(
        joinSchema.tableName, preparedRecords as DbRecord[], childPkCol
      );
    }

    return pkRows.map((r) => camelcaseObject(r, joinSchema));
  });
}

/**
 * Process per-alias deletion requests for a write join.
 *
 * The FK from `mainRecord` (matching `joinDef.mainField` → `joinDef.joinField`) is
 * auto-injected into every deletion record. This means the consumer can provide just
 * the PK (e.g. `{ id: 5 }`) and the engine will run
 * `DELETE FROM child WHERE id = 5 AND fk_to_main = <main.id>` — both ergonomic
 * (no need to repeat the FK) and safer (cannot accidentally delete a row that
 * doesn't belong to this main).
 *
 * The FK alone is not isolation: a child row owned by another tenant may still point at a main
 * row the caller owns, so the child table's own `tenantScope` is added to the DELETE.
 */
export function processDeletions(
  pass: WriteJoinPass,
  deletions: Record<string, Record<string, unknown>[]>
): Promise<Record<string, Record<string, unknown>[]>> {
  const { db } = pass;

  return forEachWriteJoin(pass, deletions, async (records, target) => {
    const { joinSchema, joinCol, mainValue, childTenant } = target;
    const tenantGuard = buildTenantRowGuard(db, childTenant, joinSchema.tableName);
    const deletedRows: Record<string, unknown>[] = [];

    for (const rec of records) {
      const snaked = snakecaseRecord(rec, joinSchema) as DbRecord;
      // Auto-inject FK to main: scopes the DELETE to children owned by this main.
      snaked[joinCol] = mainValue as DbRecord[string];
      const affectedRows = await db.delete(joinSchema.tableName, snaked, tenantGuard);
      if (affectedRows > 0) {
        deletedRows.push(camelcaseObject(snaked as Record<string, unknown>, joinSchema));
      }
    }

    return deletedRows;
  });
}
