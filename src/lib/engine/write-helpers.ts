import type { ApiRequest } from '../../types/request.js';
import { camelcaseObject, snakecaseRecord } from '../naming.js';
import { buildKeyMatch, type QueryClient } from '../db.js';
import { ConditionBuilder, type ConditionValue } from 'node-condition-builder';
import { runValidation } from './validate.js';
import { removeWriteExcluded, insertExcludedFields } from '../write-access.js';
import { resolveJoinTableConf } from '../table-helpers.js';
import { httpError } from '../errors.js';
import {
  tenantForTable,
  buildTenantRowGuard,
  enforceTenantOnWrites,
  assertTenantOwnsConflicts,
  tenantImmutableColumns,
} from '../tenant.js';
import type {
  TableConfig,
  DbTables,
  JoinDefinition,
  DbRecord,
  TenantContext,
  SchemaDefinition,
  RowsByAlias,
  WriteJoinSections,
} from '../../types.js';
import { rejectRetiredKey } from './search/fields.js';

/**
 * Every upserted record must carry its key (ADR 0021), checked on the record as it reaches the
 * database — after hooks, tenant injection and the FK auto-fill of secondaries:
 * - a natural key needs every field present and not null: a NULL never conflicts, so the row
 *   could only be inserted and never found again by its key;
 * - on the primary key, a record naming no PK field at all is a plain insert with a generated
 *   key; one naming it only in part, or as null, is refused like a natural key;
 * - two records of one request with the same key are refused: PostgreSQL cannot affect a row
 *   twice in one statement, MySQL would let the last one win.
 * Throws 400 before any SQL runs. Column names and record keys are DB column names.
 */
export function assertUpsertKeys(
  schema: SchemaDefinition,
  conflictCols: string[],
  pkCols: string[],
  records: Record<string, unknown>[]
): void {
  const isPrimaryKey = conflictCols.length === pkCols.length
    && conflictCols.every((c) => pkCols.includes(c));
  const fieldOf = (col: string): string =>
    Object.keys(schema.fields).find((f) => schema.col(f) === col) ?? col;
  const rule = `Upsert on "${schema.tableName}" by (${conflictCols.map(fieldOf).join(', ')})`;
  const seen = new Map<string, number>();

  records.forEach((record, i) => {
    if (isPrimaryKey && conflictCols.every((c) => record[c] === undefined)) return;

    const missing = conflictCols.filter((c) => record[c] == null);
    // Not attributable to one request path here: the rows may be a bulk's mains or one
    // write's secondaries, and the message carries the index either way.
    if (missing.length) {
      throw httpError(
        400,
        `${rule}: the row at index ${i} has no value for ${missing.map(fieldOf).join(', ')} — ` +
        `an upserted row must carry its whole key`,
        { code: 'missing_key' }
      );
    }
    const key = JSON.stringify(conflictCols.map((c) => record[c]));
    const first = seen.get(key);
    if (first !== undefined) {
      throw httpError(400, `${rule}: the rows at index ${first} and ${i} have the same key`, { code: 'duplicate_key' });
    }
    seen.set(key, i);
  });
}

/**
 * Resolve the write join an alias names, or undefined when the table does not declare it.
 * An undeclared alias never gets this far: `assertWriteJoinAliases` refuses it first.
 */
function findWriteJoin(
  tableConf: TableConfig,
  alias: string
): JoinDefinition | undefined {
  return tableConf.writeJoins?.find((j) => j.alias === alias);
}

/** True when any of `sections` names at least one alias — an empty list included. */
export function hasAliases(...sections: (RowsByAlias | undefined)[]): boolean {
  return sections.some((s) => s !== undefined && Object.keys(s).length > 0);
}

/** The sections of a write request, in the order their aliases are checked. */
const SECTIONS = ['upsert', 'delete', 'replace'] as const;

/**
 * Refuse the pre-1.0 child-row keys of a write request: `secondaries` became `upsert` and
 * `deletions` became `delete` (ADR 0029). A 400 `retired_key` at `<at>.<key>`, never ignored:
 * dropped, the child rows would go unwritten or undeleted with the write answering success.
 * `at` is the bulk item's index, empty for a single write.
 */
export function rejectRetiredWriteKeys(input: object, at = ''): void {
  const path = (key: string): string => [at, key].filter(Boolean).join('.');
  rejectRetiredKey(input, 'secondaries', path('secondaries'), `child rows to write go under 'upsert', a complete set under 'replace'`);
  rejectRetiredKey(input, 'deletions', path('deletions'), `child rows to delete go under 'delete'`);
}

/**
 * Check the aliases of a write request's `upsert`, `delete` and `replace` sections, before
 * anything is validated or written; a 400 at `<at>.<section>.<alias>`:
 * - `unknown_field` for an alias the table does not declare in `writeJoins`. Dropped in
 *   silence, a typo'd alias would answer success with the child rows unwritten, or the rows to
 *   delete still there;
 * - `unknown_field` for a `replace` alias whose relation has no `upsertKey`: the key is what
 *   tells a child row the request sends from one to delete;
 * - `conflicting_alias` for an alias in `replace` and in `upsert` or `delete` too: the set
 *   `replace` names already says what stays and what goes.
 * `at` is the bulk item's index, empty for a single write.
 */
export function assertWriteJoinAliases(tableConf: TableConfig, sections: WriteJoinSections, at = ''): void {
  for (const section of SECTIONS) {
    for (const alias of Object.keys(sections[section] ?? {})) {
      const join = findWriteJoin(tableConf, alias);
      const path = [at, section, alias].filter(Boolean).join('.');
      if (!join) {
        throw httpError(400, `Unknown write join alias: ${alias}`, { code: 'unknown_field', path });
      }
      if (section === 'replace' && !join.upsertKey) {
        throw httpError(
          400,
          `'${alias}' cannot be replaced: its relation declares no upsertKey to tell the rows apart`,
          { code: 'unknown_field', path }
        );
      }
      if (section === 'replace' && (Object.hasOwn(sections.upsert ?? {}, alias) || Object.hasOwn(sections.delete ?? {}, alias))) {
        throw httpError(
          400,
          `'${alias}' is under replace and under upsert or delete: replace already names the complete set`,
          { code: 'conflicting_alias', path }
        );
      }
    }
  }
}

/**
 * Drop `insertExclude` fields from a camelCase record, in place.
 *
 * Exclusion is a whitelist on CLIENT input: call this on the client payload only, BEFORE any
 * server-side value is assigned (beforeInsert mutations, FK auto-fill), so engine- and
 * hook-generated values on those fields reach the SQL (ADR 0005).
 */
function removeInsertExcluded(
  record: Record<string, unknown>,
  tableConf: TableConfig
): void {
  for (const field of insertExcludedFields(tableConf)) {
    delete record[field];
  }
}

/**
 * The context a per-alias write pass runs in. Shared by `processSecondaries` and
 * `processDeletions`, which differ only in the payload they are handed.
 */
export interface WriteJoinPass {
  db: QueryClient;
  tableConf: TableConfig;
  dbTables: DbTables;
  /** Main record (camelCase), the source of the FK auto-filled into every child row. */
  mainRecord: Record<string, unknown>;
  tenant?: TenantContext;
  /** The request that triggered the write, handed to the child table's `beforeInsert`. */
  request: ApiRequest | undefined;
}

/** Everything both `processSecondaries` and `processDeletions` need to write one alias. */
interface WriteJoinTarget {
  joinSchema: JoinDefinition['joinSchema'];
  /** Child column holding the FK back to the main row. */
  joinCol: string;
  /** Value that FK takes, read off the main record. */
  mainValue: unknown;
  childConf: TableConfig | undefined;
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
  const childConf = resolveJoinTableConf(dbTables, joinDef);
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
  tableConf: TableConfig;
  request: ApiRequest | undefined;
}

/**
 * Prepare a single record for INSERT/UPSERT:
 *   1. shallow camelCase copy of `input`
 *   2. runValidation (camelCase — sees the client payload as sent)
 *   3. drop insertExclude fields (client-input whitelist; applied BEFORE the
 *      hook so values it assigns — e.g. a server-generated id — reach the INSERT)
 *   4. beforeInsert hook (caller can mutate the camelCase copy)
 *   5. drop non-writable fields (generated columns, writeExclude) — AFTER the hook, because
 *      the database refuses those values whoever assigned them
 *   6. snakecaseRecord → DB format
 *
 * Returns both `camel` (input + hook mutations, used for FK auto-fill / afterInsert) and
 * `snake` (DB-ready record). The original `input` is left intact.
 *
 * Pass the request's `upsert`/`replace` sections so the validate hook receives them; set
 * `skipValidate` when a bulk-level validator already ran.
 */
export async function prepareInsertRecord(
  ctx: PrepareCtx,
  input: Record<string, unknown>,
  children: Pick<WriteJoinSections, 'upsert' | 'replace'> = {},
  options?: { skipValidate?: boolean }
): Promise<{ camel: Record<string, unknown>; snake: Record<string, unknown> }> {
  const camel: Record<string, unknown> = { ...input };
  if (!options?.skipValidate) {
    await runValidation(ctx.db, ctx.request, ctx.tableConf, camel, children);
  }
  removeInsertExcluded(camel, ctx.tableConf);
  if (ctx.tableConf.beforeInsert) {
    await ctx.tableConf.beforeInsert({ db: ctx.db, req: ctx.request, record: camel });
  }
  removeWriteExcluded(camel, ctx.tableConf, ctx.tableConf.schema);
  const snake = snakecaseRecord(camel, ctx.tableConf.schema);
  return { camel, snake };
}

/** What `processSecondaries` did: the child rows written, and those a `replace` removed. */
export interface SecondariesOutcome {
  written: RowsByAlias;
  removed: RowsByAlias;
}

/**
 * Write the child rows of a request's `upsert` and `replace` sections, one bulk statement per
 * alias; for a `replace` alias, then delete every other child row of the main row (ADR 0029).
 *
 * A secondary is a write like any other: the child table's own `tenantScope` is enforced on it
 * (`tenantForTable` re-targets the caller's tenant onto that table's scope). Without this the
 * client picks the child's tenant value, which lets it plant rows inside another tenant — and,
 * where the child is upserted, hijack one of that tenant's existing rows via the conflict key.
 *
 * An empty list writes nothing; under `replace` it still removes every child row. An alias the
 * table does not declare is skipped: `assertWriteJoinAliases` refuses it first.
 */
export async function processSecondaries(
  pass: WriteJoinPass,
  sections: Pick<WriteJoinSections, 'upsert' | 'replace'>
): Promise<SecondariesOutcome> {
  const outcome: SecondariesOutcome = { written: {}, removed: {} };
  const aliases: [string, Record<string, unknown>[] | undefined, boolean][] = [
    ...Object.entries(sections.upsert ?? {}).map(([a, r]): [string, typeof r, boolean] => [a, r, false]),
    ...Object.entries(sections.replace ?? {}).map(([a, r]): [string, typeof r, boolean] => [a, r, true]),
  ];

  for (const [alias, records, replace] of aliases) {
    const joinDef = findWriteJoin(pass.tableConf, alias);
    if (!joinDef || (!records?.length && !replace)) continue;

    const target = resolveWriteJoinTarget(joinDef, pass.dbTables, pass.mainRecord, pass.tenant);
    const sent = records?.length ? await writeSecondaryRows(pass, records, target, joinDef) : [];
    if (records?.length) outcome.written[alias] = sent.map((r) => camelcaseObject(r.pk, target.joinSchema));

    if (replace) {
      const removed = await removeUnsentChildren(pass.db, target, joinDef, sent.map((r) => r.record));
      if (removed.length) outcome.removed[alias] = removed;
    }
  }

  return outcome;
}

/** The child table's primary key fields: its config's, else the Schema's, else the join field. */
function childPrimaryKey(target: WriteJoinTarget, joinDef: JoinDefinition): string | string[] {
  return target.childConf?.primary ?? target.joinSchema.primaryKey ?? joinDef.joinField;
}

/**
 * Insert, or upsert on the relation's `upsertKey`, one alias' rows: each row's PK (DB columns)
 * and the record as written, FK and tenant included — the key a `replace` keeps.
 */
async function writeSecondaryRows(
  pass: WriteJoinPass,
  records: Record<string, unknown>[],
  target: WriteJoinTarget,
  joinDef: JoinDefinition
): Promise<{ pk: Record<string, unknown>; record: Record<string, unknown> }[]> {
  const { db, request } = pass;
  const { joinSchema, joinCol, mainValue, childConf, childTenant } = target;

  const childPk = childPrimaryKey(target, joinDef);
  const childPkCol = Array.isArray(childPk)
    ? childPk.map((f) => joinSchema.col(f))
    : joinSchema.col(childPk);

  // Same order as `prepareInsertRecord` (ADR 0005): the client whitelist runs first, then
  // the FK to the main row, then the child's own `beforeInsert`, then the DB format — so a
  // value the hook assigns to an excluded field still reaches the INSERT. A secondary is a write like any other, and its
  // table's transform has to run here too or a column that table encodes on the way in is
  // stored raw whenever its rows arrive as another table's children.
  const preparedRecords: Record<string, unknown>[] = [];
  for (const rec of records) {
    const camel = { ...rec };
    if (childConf) {
      removeInsertExcluded(camel, childConf);
      // The hook sees the row as it will be written: the FK to the main row already filled in,
      // over whatever the client sent. It is filled again below, so the hook cannot move it.
      camel[joinDef.joinField] = mainValue;
      if (childConf.beforeInsert) {
        await childConf.beforeInsert({ db, req: request, record: camel });
      }
    }
    removeWriteExcluded(camel, childConf, joinSchema);
    const prepared = snakecaseRecord(camel, joinSchema);
    // FK auto-fill last: the engine's own value, not the client's and not the hook's.
    prepared[joinCol] = mainValue;
    preparedRecords.push(prepared);
  }

  // Tenant enforcement runs after the FK auto-fill: for an indirect scope the through-FK
  // the engine just injected is the value being validated.
  await enforceTenantOnWrites(db, childTenant, preparedRecords);

  const upsertKeys = joinDef.upsertKey;
  let pkRows: Record<string, unknown>[];

  if (upsertKeys) {
    const conflictCols = upsertKeys.map((k) => joinSchema.col(k));
    assertUpsertKeys(
      joinSchema, conflictCols, (joinSchema.primaryKey ?? [childPk].flat()).map((f) => joinSchema.col(f)),
      preparedRecords
    );
    // A conflicting upsert must not overwrite — or re-parent — a child row owned by
    // another tenant, which the ON CONFLICT key alone would happily match.
    await assertTenantOwnsConflicts(
      db, childTenant, joinSchema.tableName, conflictCols, preparedRecords
    );
    pkRows = (await db.bulkUpsert(
      joinSchema.tableName, preparedRecords as DbRecord[], conflictCols, childPkCol,
      { immutableCols: tenantImmutableColumns(childTenant) }
    )).map((r) => r.pk);
  } else {
    pkRows = await db.bulkInsert(
      joinSchema.tableName, preparedRecords as DbRecord[], childPkCol
    );
  }

  return pkRows.map((pk, i) => ({ pk, record: preparedRecords[i] }));
}

/**
 * Delete the child rows of the main row that a `replace` section left out: every
 * row with the main row's FK whose `upsertKey` matches none of the rows just written. The
 * child table's tenant guard joins the statement, so a row of another tenant pointing at this
 * main row is never touched. A row with a NULL key matches nothing sent and is removed too
 * (`NOT COALESCE(…, FALSE)`). Returns the removed rows' keys — primary key and `upsertKey`
 * fields — as `deletions` reports them.
 */
async function removeUnsentChildren(
  db: QueryClient,
  target: WriteJoinTarget,
  joinDef: JoinDefinition,
  kept: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const { joinSchema, joinCol, mainValue, childTenant } = target;
  const table = db.qi(joinSchema.tableName);
  const keyCols = (joinDef.upsertKey ?? []).map((f) => joinSchema.col(f));
  const pkCols = [childPrimaryKey(target, joinDef)].flat().map((f) => joinSchema.col(f));
  const reported = [...new Set([...pkCols, ...keyCols])].map((c) => db.qi(c)).join(', ');

  const cb = new ConditionBuilder('AND', db.cbDialect);
  cb.isEqual(db.qi(joinCol), mainValue as ConditionValue);
  if (kept.length) {
    const match = buildKeyMatch(
      db, keyCols.map((c) => db.qi(c)), kept.map((r) => keyCols.map((c) => r[c] as ConditionValue))
    ).toExpression();
    cb.raw(`NOT COALESCE(${match.value}, FALSE)`, [...match.values]);
  }
  const guard = buildTenantRowGuard(db, childTenant, joinSchema.tableName);
  if (guard) cb.append(guard);
  const where = cb.build(1, db.ph);
  const values = cb.getValues();

  let rows: Record<string, unknown>[];
  if (db.supportsReturning) {
    rows = (await db.query(`DELETE FROM ${table} WHERE ${where}${db.returningPk(reported)}`, values)).rows;
  } else {
    // No RETURNING (mysql): read the rows through the same WHERE, then delete them.
    rows = (await db.query(`SELECT ${reported} FROM ${table} WHERE ${where}`, values)).rows;
    if (rows.length) await db.query(`DELETE FROM ${table} WHERE ${where}`, values);
  }
  return rows.map((r) => camelcaseObject(r, joinSchema));
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
export async function processDeletions(
  pass: WriteJoinPass,
  deletions: RowsByAlias
): Promise<RowsByAlias> {
  const { db } = pass;
  const results: RowsByAlias = {};

  for (const [alias, records] of Object.entries(deletions)) {
    const joinDef = findWriteJoin(pass.tableConf, alias);
    if (!joinDef || !records?.length) continue;

    const { joinSchema, joinCol, mainValue, childTenant } =
      resolveWriteJoinTarget(joinDef, pass.dbTables, pass.mainRecord, pass.tenant);
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
    results[alias] = deletedRows;
  }

  return results;
}
