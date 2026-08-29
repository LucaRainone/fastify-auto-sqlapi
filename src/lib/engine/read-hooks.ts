import type { ApiRequest } from '../../types/request.js';
import type { QueryClient } from '../db.js';
import type { AfterReadContext, ITable, ReadSource } from '../../types.js';

/**
 * Run a table's `afterRead` hook over the rows a read produced.
 *
 * Every read path funnels through this one helper so the hook has a single meaning: it is
 * handed camelCase rows of `tableConf`'s own table, in one batch, and mutates them in place.
 * Batching is the contract, not an optimisation — a hook that decrypts through a remote KMS
 * gets one call per result set instead of one per row.
 *
 * `tableConf` is resolved by the caller, which on a join is the JOINED table's config
 * (`dbTables[joinSchema.tableName]`). That is what makes the hook follow a relation without
 * being declared on the host, the way `readExclude` and `tenantScope` do (ADR 0010).
 *
 * An empty result set is skipped: there is nothing to transform, and the hook may be costly.
 */
export async function runAfterRead(
  db: QueryClient,
  request: ApiRequest | undefined,
  rows: Record<string, unknown>[],
  tableConf: ITable | undefined,
  source: ReadSource,
  alias?: string
): Promise<void> {
  if (!tableConf?.afterRead || rows.length === 0) return;
  const ctx: AfterReadContext = alias === undefined ? { source } : { source, alias };
  await tableConf.afterRead(db, request, rows, ctx);
}
