// Re-export utilities
export {
  toCamelCase,
  toUnderscore,
  toSchemaName,
  camelcaseObject,
  snakecaseRecord,
} from './lib/naming.js';

// Errors: throw from a hook to answer in the plugin's envelope (a 400 with `fields`)
export { httpError, type HttpErrorField } from './lib/errors.js';

// DB
export { QueryClient, createQueryClient } from './lib/db.js';

// Dialect
export { getDialect, type SqlDialect, type DialectName } from './lib/dialect.js';

// Adapters
export { pgQueryable } from './lib/adapters/pg-adapter.js';
export { mysqlQueryable } from './lib/adapters/mysql-adapter.js';

// Table helpers
export { defineTable, buildRelation } from './lib/table-helpers.js';
export type { TableDefinition } from './lib/table-helpers.js';
export { Nullable } from './lib/nullable.js';

// Agent / LLM client helpers
export {
  buildAgentManifest,
  renderAgentManifestMd,
  type AgentManifest,
  type ManifestTable,
} from './lib/agent/manifest.js';
export { agentToolSchemas, type AgentToolSchemas } from './lib/agent/tool-schemas.js';

// Tenant
export { resolveTenant } from './lib/tenant.js';
export { TENANT_ADMIN } from './types.js';

// SqlApi — programmatic high-level API
export { SqlApi, createSqlApi } from './lib/sql-api.js';
export type { SqlApiOptions, SqlApiSearchParams, SqlApiInsertParams, SqlApiUpdateParams, SqlApiBulkDeleteParams } from './lib/sql-api.js';


// Plugin
export { default as fastifyAutoSqlApi } from './routes/auto/plugin.js';

// Re-export deps
export { Type, type Static } from 'typebox';
export { ConditionBuilder, Expression } from 'node-condition-builder';

// Types
export type {
  ApiRequest,
  SqlApiConfig,
  ColumnInfo,
  TableMap,
  Queryable,
  TransactionQueryable,
  SqlResult,
  DbRecord,
  DbRecordValue,
  WriteAction,
  WrittenRow,
  SelectOptions,
  SchemaDefinition,
  JoinDefinition,
  RowsByAlias,
  TableConfig,
  TableOperation,
  DbTables,
  SqlApiPluginOptions,
  SwaggerOptions,
  DbErrorMapping,
  SearchParams,
  SearchResult,
  Paginator,
  ComputeFn,
  ComputeRequest,
  ComputedResult,
  PaginationResult,
  ExtendedConditionFn,
  FilterRecord,
  AggregationRequest,
  JoinGroupRequest,
  ComputedFieldFn,
  ComputedFieldContext,
  ComputedFieldExpr,
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
  TenantAdmin,
  TenantResolution,
  GetTenantId,
  TenantScope,
  TenantScopeDirect,
  TenantScopeIndirect,
  TenantScopeAnyOf,
  TenantContext,
  ValidationField,
  ValidateContext,
  BulkValidateContext,
  HookContext,
  WriteRecord,
  WriteHookContext,
  AfterInsertContext,
  AfterUpdateContext,
  AfterReadContext,
  ReadSource,
  DeleteHookContext,
  BulkDeleteHookContext,
  ValidatorFn,
  BulkValidatorItem,
  BulkValidatorFn,
} from './types.js';
