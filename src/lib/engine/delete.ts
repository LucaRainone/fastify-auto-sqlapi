import { camelcaseObject } from '../naming.js';
import type { DeleteParams, DeleteResult } from '../../types.js';
import type { DbRecord } from '../../types.js';

export async function deleteEngine(params: DeleteParams): Promise<DeleteResult> {
  const { db, tableConf, id } = params;
  const pkCol = tableConf.Schema.col(tableConf.primary);

  const rows = await db.delete(tableConf.Schema.tableName, { [pkCol]: id } as DbRecord);

  if (rows.length === 0) {
    const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return { main: camelcaseObject(rows[0]) };
}
