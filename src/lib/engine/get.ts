import { camelcaseObject } from '../naming.js';
import { escapeIdent } from '../db.js';
import type { GetParams, GetResult } from '../../types.js';

export async function getEngine(params: GetParams): Promise<GetResult> {
  const { db, tableConf, id } = params;
  const pkCol = tableConf.Schema.col(tableConf.primary);

  const rows = await db.select({
    tableName: tableConf.Schema.tableName,
    where: `"${escapeIdent(pkCol)}" = $1`,
    values: [id],
    limit: '1',
  });

  if (rows.length === 0) {
    const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return { main: camelcaseObject(rows[0] as Record<string, unknown>) };
}
