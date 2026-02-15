// Re-export utilities
export {
  toCamelCase,
  toUnderscore,
  toSchemaName,
  camelcaseObject,
  snakecaseRecord,
} from './lib/naming.js';

// DB
export { QueryClient } from './lib/db.js';

// Re-export deps
export { Type, type Static } from '@sinclair/typebox';
export { ConditionBuilder, Expression } from 'node-condition-builder';

// Types
export type {
  SqlApiConfig,
  ColumnInfo,
  TableMap,
  Queryable,
  DbRecord,
  DbRecordValue,
  SelectOptions,
} from './types.js';
