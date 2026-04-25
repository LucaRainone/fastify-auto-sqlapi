import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DialectName } from '../lib/dialect.js';
import type { DbTables } from './table.js';
import type { TenantId } from './tenant.js';

export interface SwaggerOptions {
  title?: string;
  description?: string;
  version?: string;
  routePrefix?: string;
}

export interface SqlApiPluginOptions {
  DbTables: DbTables;
  onRequests?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>)[];
  prefix?: string;
  swagger?: boolean | SwaggerOptions;
  dialect?: DialectName;
  getTenantId?: (request: FastifyRequest) => TenantId | TenantId[] | null | undefined
    | Promise<TenantId | TenantId[] | null | undefined>;
  debug?: boolean;
}
