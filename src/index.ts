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

// Table helpers
export { exportTableInfo, defineTable, buildRelation, buildUpsertRule, buildUpsertRules } from './lib/table-helpers.js';

// Search
export { searchEngine } from './lib/search-engine.js';
export { SearchTableBodyPost, SearchTableQueryString, SearchTableResponse } from './lib/search-schema.js';
export { default as searchRoutes } from './routes/auto/search.routes.js';

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
  SchemaDefinition,
  JoinDefinition,
  ITable,
  DbTables,
  SqlApiPluginOptions,
  SwaggerOptions,
  SearchParams,
  SearchResult,
  Paginator,
  PaginationResult,
  TableFilterFn,
  ExtendedConditionFn,
  AggregationRequest,
  JoinGroupRequest,
} from './types.js';
