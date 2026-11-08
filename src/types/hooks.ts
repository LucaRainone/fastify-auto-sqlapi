import type { TSchema, Static } from 'typebox';
import type { Expression } from 'node-condition-builder';
import type { ApiRequest } from './request.js';
import type { QueryClient } from '../lib/db.js';
import type { RowsByAlias } from './join.js';

/**
 * What every hook and validator of a table config receives: one object, so a new piece of
 * information is a new property rather than a new positional parameter, and so the request
 * is typed as what it is.
 *
 * - `db`: the QueryClient the operation runs on — inside a write, the transaction's client,
 *   so a statement the hook issues commits or rolls back with the write.
 * - `req`: the request that triggered the operation. Present through the auto-generated
 *   HTTP routes; `undefined` when `sqlApi.*` is called without one (a job, a script, a
 *   test). A hook reading `req.user` must guard for it.
 */
export interface HookContext {
  db: QueryClient;
  req: ApiRequest | undefined;
}

/** A camelCase record on its way to the database: fields may carry raw SQL (`db.expression`) or `null`. */
export type WriteRecord<F extends Record<string, TSchema> = Record<string, TSchema>> = {
  [K in keyof F]?: Static<F[K]> | Expression | null;
};

/** `beforeInsert` / `beforeUpdate`: the record about to be written, mutable in place. */
export interface WriteHookContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends HookContext {
  record: WriteRecord<F>;
}

/** `afterInsert`: the input record merged with the generated primary key, and the secondaries written, by alias. */
export interface AfterInsertContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends HookContext {
  record: WriteRecord<F>;
  secondaries?: RowsByAlias;
}

/** `afterUpdate`: as `afterInsert`, plus the child rows removed through `deletions`, by alias. */
export interface AfterUpdateContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends AfterInsertContext<F> {
  deletions?: RowsByAlias;
}

/** Which read path produced the rows an `afterRead` hook is handed. */
export type ReadSource = 'get' | 'search' | 'joinMultiple' | 'joinLeft';

/** `afterRead`: the camelCase rows a read produced, mutable in place, and where they came from. */
export interface AfterReadContext extends HookContext {
  rows: Record<string, unknown>[];
  source: ReadSource;
  /** The relation's alias, on the two join sources; absent on `get` and `search`. */
  alias?: string;
}

/** `beforeDelete` / `afterDelete`: the primary key of the row. */
export interface DeleteHookContext extends HookContext {
  id: string | number;
}

/**
 * `beforeBulkDelete` / `afterBulkDelete`: the primary keys — those requested before the delete,
 * those actually deleted after it (a subset when some rows did not exist).
 */
export interface BulkDeleteHookContext extends HookContext {
  ids: (string | number)[];
}
