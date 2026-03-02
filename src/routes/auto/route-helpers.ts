import type { FastifyInstance } from 'fastify';
import { createQueryClient, type QueryClient } from '../../lib/db.js';
import { pgQueryable } from '../../lib/adapters/pg-adapter.js';
import { mysqlQueryable } from '../../lib/adapters/mysql-adapter.js';

export function getDb(fastify: FastifyInstance, dialect?: string): QueryClient {
  const pool = (dialect === 'mysql' || dialect === 'mariadb')
    ? mysqlQueryable((fastify as any).mysql)
    : pgQueryable((fastify as any).pg);
  return createQueryClient(pool, dialect);
}
