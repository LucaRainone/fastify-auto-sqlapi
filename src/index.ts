// Re-export utilities
export {
  toCamelCase,
  toUnderscore,
  toSchemaName,
  camelcaseObject,
  snakecaseRecord,
} from './lib/naming.js';

// DB
export { QueryClient, createQueryClient, escapeIdent } from './lib/db.js';

// Dialect
export { getDialect, type SqlDialect, type DialectName } from './lib/dialect.js';

// Adapters
export { pgQueryable } from './lib/adapters/pg-adapter.js';
export { mysqlQueryable } from './lib/adapters/mysql-adapter.js';

// Table helpers
export { exportTableInfo, defineTable, buildRelation, buildUpsertRule, buildUpsertRules } from './lib/table-helpers.js';

// Tenant
export { resolveTenant } from './lib/tenant.js';

// SqlApi — programmatic high-level API
export { SqlApi, createSqlApi } from './lib/sql-api.js';
export type { SqlApiOptions, SqlApiSearchParams, SqlApiInsertParams, SqlApiUpdateParams } from './lib/sql-api.js';


// Plugin
export { default as fastifyAutoSqlApi } from './routes/auto/plugin.js';

// Swagger
export { setupSwagger } from './lib/setup-swagger.js';

// Search
export { searchEngine } from './lib/engine/search/search.js';
export { SearchTableBodyPost, SearchTableQueryString, SearchTableResponse } from './lib/schema/search.js';
export { default as searchRoutes } from './routes/auto/search.routes.js';

// Insert
export { insertEngine } from './lib/engine/rest/insert.js';
export { InsertTableBody, InsertTableResponse } from './lib/schema/insert.js';
export { default as insertRoutes } from './routes/auto/insert.routes.js';

// Get
export { getEngine } from './lib/engine/rest/get.js';
export { default as getRoutes } from './routes/auto/get.routes.js';

// Delete
export { deleteEngine } from './lib/engine/rest/delete.js';
export { default as deleteRoutes } from './routes/auto/delete.routes.js';

// Update
export { updateEngine } from './lib/engine/rest/update.js';
export { UpdateTableBody, UpdateTableResponse } from './lib/schema/update.js';
export { default as updateRoutes } from './routes/auto/update.routes.js';

// Bulk Upsert
export { bulkUpsertEngine } from './lib/engine/bulk/bulk-upsert.js';
export { BulkUpsertTableBody, BulkUpsertTableResponse } from './lib/schema/bulk-upsert.js';
export { default as bulkUpsertRoutes } from './routes/auto/bulk-upsert.routes.js';

// Bulk Delete
export { bulkDeleteEngine } from './lib/engine/bulk/bulk-delete.js';
export { BulkDeleteTableBody, BulkDeleteTableResponse } from './lib/schema/bulk-delete.js';
export { default as bulkDeleteRoutes } from './routes/auto/bulk-delete.routes.js';

// Re-export deps
export { Type, type Static } from '@sinclair/typebox';
export { ConditionBuilder, Expression } from 'node-condition-builder';

// Types
export type {
  SqlApiConfig,
  ColumnInfo,
  TableMap,
  Queryable,
  SqlResult,
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
  FilterRecord,
  AggregationRequest,
  JoinGroupRequest,
  GetParams,
  GetResult,
  DeleteParams,
  DeleteResult,
  InsertParams,
  InsertResult,
  BulkUpsertItem,
  BulkUpsertParams,
  BulkUpsertResult,
  BulkDeleteParams,
  BulkDeleteResult,
  ConditionMethod,
  SearchCondition,
  UpdateParams,
  UpdateResult,
  TenantId,
  TenantScope,
  TenantScopeDirect,
  TenantScopeIndirect,
  TenantContext,
  ValidationError,
  ValidatorFn,
  BulkValidatorItem,
  BulkValidatorFn,
} from './types.js';
