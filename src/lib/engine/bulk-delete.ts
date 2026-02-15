import { camelcaseObject } from '../naming.js';
import { escapeIdent } from '../db.js';
import type { BulkDeleteParams, BulkDeleteResult } from '../../types.js';

export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids } = params;
  if (!ids.length) return [];

  const pkCol = tableConf.Schema.col(tableConf.primary);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');

  const result = await db.query(
    `DELETE FROM "${escapeIdent(tableConf.Schema.tableName)}"
     WHERE "${escapeIdent(pkCol)}" IN (${placeholders})
     RETURNING *`,
    ids
  );

  return result.rows.map((row) => ({
    main: camelcaseObject(row as Record<string, unknown>),
  }));
}
