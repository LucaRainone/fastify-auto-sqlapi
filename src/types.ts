// Public type entry-point. Re-exports all internal type modules under a single
// namespace so consumers can keep importing from `'fastify-auto-sqlapi'`/`./types`.
export type { DialectName } from './lib/dialect.js';

export * from './types/cli.js';
export * from './types/db.js';
export * from './types/schema.js';
export * from './types/tenant.js';
export * from './types/computed.js';
export * from './types/conditions.js';
export * from './types/join.js';
export * from './types/validation.js';
export * from './types/table.js';
export * from './types/plugin.js';
export * from './types/search.js';
export * from './types/dml.js';
