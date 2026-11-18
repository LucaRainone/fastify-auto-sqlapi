// What a documentation sample takes from the reader's own application, declared once so that the
// samples typecheck against the published types (test/unit/docs-contract.test.js).
//
// Only the application's side belongs here: its auth, its pools, its request user. Anything
// the library provides must come from 'fastify-auto-sqlapi' in the sample itself, or from the
// generated Schemas the test writes with the real CLI codegen.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';

declare module 'fastify' {
  // What an auth plugin (e.g. @fastify/jwt) puts on the request.
  interface FastifyRequest {
    user?: {
      id: number;
      role: string;
      isAdmin: boolean;
      isSuperadmin: boolean;
      organizationId: number;
      orgId: number;
    };
  }
}

declare global {
  /** The application's Fastify instance, in samples that do not create it. */
  const app: FastifyInstance;
  const fastify: FastifyInstance;
  /** The application's auth hooks. */
  const auth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  const agentAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** The application's MySQL driver and pool settings. */
  const mysql: typeof import('mysql2/promise');
  const pool: Pool;
  const host: string;
  const user: string;
  const password: string;
  const database: string;
  /** The application's language setting, in a computed-field sample. */
  const LANG: string;
}

export {};
