import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ITable, SqlApiPluginOptions } from '../../types.js';

type RequestHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;

export function mergeOnRequests(options: SqlApiPluginOptions, tableConf: ITable): RequestHook[] {
  return [...(options.onRequests || []), ...(tableConf.onRequests || [])];
}

export function buildWriteDescription(action: string, tableName: string, tableConf: ITable): string {
  const joinList = tableConf.allowedWriteJoins
    ?.map(([joinSchema]) => joinSchema.tableName)
    .join(', ');
  return [
    `${action} ${tableName}`,
    joinList && `Available secondaries: ${joinList}`,
  ].filter(Boolean).join('. ');
}
