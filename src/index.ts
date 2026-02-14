// Re-export utilities
export { toCamelCase, toUnderscore, toSchemaName } from './lib/naming.js';

// Re-export deps
export { Type, type Static } from '@sinclair/typebox';
export { ConditionBuilder } from 'node-condition-builder';

// Types
export type { SqlApiConfig, ColumnInfo, TableMap } from './types.js';
