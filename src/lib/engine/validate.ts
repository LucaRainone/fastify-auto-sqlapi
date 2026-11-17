import type { ApiRequest } from '../../types/request.js';
import type { QueryClient } from '../db.js';
import { resolveJoinTableConf } from '../table-helpers.js';
import type {
  TableConfig,
  DbTables,
  JoinDefinition,
  ValidationField,
  ValidateParent,
  BulkValidatorItem,
  WriteJoinSections,
} from '../../types.js';

/**
 * The fields of the 400 for what a `validate`/`validateBulk` hook returned: the `{ path, code }`
 * objects as they are, with no `message` — a hook writes no prose, the client translates the
 * code. Anything else is the hook's bug, not the client's — a plain Error (500), never a 400 —
 * and the pre-1.0 tuples are named, so they are not read positionally into the wrong fields.
 */
function toResponseFields(hook: string, errors: unknown): ValidationField[] {
  if (!Array.isArray(errors)) {
    throw new Error(`${hook} must return an array of { path, code } objects (empty: valid)`);
  }
  return errors.map((entry: unknown, i) => {
    const at = `${hook} returned [${i}]`;
    if (Array.isArray(entry)) {
      throw new Error(`${at} as a tuple, the pre-1.0 shape: return { path, code } objects`);
    }
    if (!entry || typeof entry !== 'object') throw new Error(`${at}: expected { path, code }`);
    const { path, code } = entry as Record<string, unknown>;
    if (Object.hasOwn(entry, 'message')) {
      throw new Error(`${at} with a 'message': return { path, code } only, the client translates the code`);
    }
    if (typeof path !== 'string') throw new Error(`${at}: path must be a string ('' when not attributable)`);
    if (typeof code !== 'string' || !code) throw new Error(`${at}: code must be a non-empty string`);
    return { path, code };
  });
}

export async function runValidation(
  db: QueryClient,
  request: ApiRequest | undefined,
  tableConf: TableConfig,
  main: Record<string, unknown>,
  children: Pick<WriteJoinSections, 'upsert' | 'replace'> = {}
): Promise<void> {
  if (!tableConf.validate) return;

  const ctx = { db, req: request, main, upsert: children.upsert, replace: children.replace };
  const fields = toResponseFields('validate', await tableConf.validate(ctx));
  if (fields.length > 0) throwValidationError(fields);
}

/** Where a child validation runs: the host table's write, and the bulk item it belongs to. */
interface ChildValidationCtx {
  db: QueryClient;
  request: ApiRequest | undefined;
  tableConf: TableConfig;
  dbTables: DbTables;
}

/**
 * Run each child table's `validate` on the child rows a write sends under `upsert` and
 * `replace` (ADR 0030), after the host's own validation and before any SQL. The child sees its
 * row as `main` — with the FK to the host's main row when `hostMain` carries the key it is read
 * from — and `parent: { alias, main: hostMain }`. A child declaring `validateBulk` gets the rows
 * of one alias at once instead. Every child row is checked, and all their errors answer one
 * 400 at the request's paths: `<at>.<section>.<alias>.<i>.<field>`.
 */
export async function runChildValidation(
  ctx: ChildValidationCtx,
  hostMain: Record<string, unknown>,
  sections: Pick<WriteJoinSections, 'upsert' | 'replace'>,
  at = ''
): Promise<void> {
  const fields: ValidationField[] = [];
  for (const section of ['upsert', 'replace'] as const) {
    for (const [alias, rows] of Object.entries(sections[section] ?? {})) {
      const join = ctx.tableConf.writeJoins?.find((j) => j.alias === alias);
      const child = join && resolveJoinTableConf(ctx.dbTables, join);
      if (!join || !child || !rows?.length || (!child.validate && !child.validateBulk)) continue;

      const prefix = [at, section, alias].filter(Boolean).join('.');
      const parent: ValidateParent = { alias, main: hostMain };
      const mains = rows.map((row) => withParentKey(row, join, hostMain));
      fields.push(...await validateChildRows(ctx, child, mains, parent, prefix));
    }
  }
  if (fields.length > 0) throwValidationError(fields);
}

/** The child row as sent, with the FK to the host's main row when the host's key is known. */
function withParentKey(row: Record<string, unknown>, join: JoinDefinition, hostMain: Record<string, unknown>): Record<string, unknown> {
  const mainField = Array.isArray(join.mainField) ? join.mainField[0] : join.mainField;
  const key = hostMain[mainField];
  return key == null ? { ...row } : { ...row, [join.joinField]: key };
}

/** One child table's verdict on the rows of one alias, its paths re-rooted at `prefix`. */
async function validateChildRows(
  ctx: ChildValidationCtx,
  child: TableConfig,
  mains: Record<string, unknown>[],
  parent: ValidateParent,
  prefix: string
): Promise<ValidationField[]> {
  const table = child.schema.tableName;
  const { db, request: req } = ctx;
  if (child.validateBulk) {
    const hook = `${table}'s validateBulk`;
    const items = mains.map((main) => ({ main }));
    return toResponseFields(hook, await child.validateBulk({ db, req, items, parent }))
      .map((f) => ({ ...f, path: rerootBulkPath(hook, f.path, prefix) }));
  }
  const fields: ValidationField[] = [];
  for (const [i, main] of mains.entries()) {
    const hook = `${table}'s validate`;
    fields.push(...toResponseFields(hook, await child.validate!({ db, req, main, parent }))
      .map((f) => ({ ...f, path: rerootRowPath(hook, f.path, `${prefix}.${i}`) })));
  }
  return fields;
}

/**
 * A child row's path in its own grammar (`main.<field>`, `main`, `''`) as a path of the
 * request (`<row>.<field>`, `<row>`). Anything else is the hook's bug: a 500 naming it.
 */
function rerootRowPath(hook: string, path: string, row: string): string {
  if (path === '' || path === 'main') return row;
  if (path.startsWith('main.')) return `${row}${path.slice('main'.length)}`;
  throw new Error(`${hook}, run on a child row, returned path '${path}': expected main.<field> or ''`);
}

/** A child `validateBulk` path (`items.<j>.main.<field>`, `items.<j>`, `''`) as a path of the request. */
function rerootBulkPath(hook: string, path: string, alias: string): string {
  if (path === '') return alias;
  const m = /^items\.(\d+)(?:\.main(\..+)?)?$/.exec(path);
  if (m) return `${alias}.${m[1]}${m[2] ?? ''}`;
  throw new Error(`${hook}, run on child rows, returned path '${path}': expected items.<i>.main.<field>, items.<i> or ''`);
}

export async function runBulkValidation(
  db: QueryClient,
  request: ApiRequest | undefined,
  tableConf: TableConfig,
  items: BulkValidatorItem[]
): Promise<void> {
  if (!tableConf.validateBulk) return;

  const fields = toResponseFields('validateBulk', await tableConf.validateBulk({ db, req: request, items }));
  if (fields.length > 0) throwValidationError(fields);
}

export function throwValidationError(fields: ValidationField[]): never {
  const error = new Error('Validation failed') as Error & {
    statusCode: number;
    validationErrors: ValidationField[];
  };
  error.statusCode = 400;
  error.validationErrors = fields;
  throw error;
}
