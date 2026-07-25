import { SearchTableBodyPost, SearchTableQuery } from '../schema/search.js';
import { InsertTableBody } from '../schema/insert.js';
import { UpdateTableBody } from '../schema/update.js';
import { BulkUpsertTableBody } from '../schema/bulk-upsert.js';
import { BulkDeleteTableBody } from '../schema/bulk-delete.js';
import { tableOperations } from './manifest.js';
import { DEFAULT_MAX_ITEMS_PER_PAGE, DEFAULT_MAX_BULK_ITEMS } from '../../types.js';
import type { DbTables } from '../../types.js';

export interface AgentToolSchemas {
  /** POST /search/{table}: `body` + `querystring` (orderBy/page/itemsPerPage/compute*). */
  search?: { body: object; querystring: object };
  insert?: { body: object };
  update?: { body: object };
  bulkUpsert?: { body: object };
  bulkDelete?: { body: object };
}

/**
 * Ready-to-use JSON Schemas for exposing a table's operations as strict LLM tools —
 * the same TypeBox schemas the HTTP routes validate with (TypeBox objects ARE plain
 * JSON Schema). Only the operations actually enabled for the table are included
 * (`operations` whitelist, composite-PK rules). `get` and `delete` take a single PK
 * path param and need no schema.
 *
 * Strict tools trade prompt size for provider-side validation; the lighter
 * alternative is a loose tool plus the plugin's structured 400 as the retry signal
 * (see "LLM / agent clients" in the README).
 */
export function agentToolSchemas(
  dbTables: DbTables,
  tableName: string,
  opts?: { maxItemsPerPage?: number; maxBulkItems?: number }
): AgentToolSchemas {
  const tableConf = dbTables[tableName];
  if (!tableConf) {
    throw new Error(`Unknown table "${tableName}". Available: ${Object.keys(dbTables).join(', ')}`);
  }

  const ops = new Set(tableOperations(tableConf));
  const out: AgentToolSchemas = {};

  if (ops.has('search')) {
    out.search = {
      body: SearchTableBodyPost(dbTables, tableName),
      querystring: SearchTableQuery(opts?.maxItemsPerPage ?? DEFAULT_MAX_ITEMS_PER_PAGE),
    };
  }
  if (ops.has('insert')) out.insert = { body: InsertTableBody(dbTables, tableName) };
  if (ops.has('update')) out.update = { body: UpdateTableBody(dbTables, tableName) };
  if (ops.has('bulkUpsert')) {
    out.bulkUpsert = {
      body: BulkUpsertTableBody(dbTables, tableName, opts?.maxBulkItems ?? DEFAULT_MAX_BULK_ITEMS),
    };
  }
  if (ops.has('bulkDelete')) {
    out.bulkDelete = {
      body: BulkDeleteTableBody(dbTables, tableName, opts?.maxBulkItems ?? DEFAULT_MAX_BULK_ITEMS),
    };
  }

  return out;
}
