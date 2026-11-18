// Errors: throw from a hook to answer in the plugin's envelope (a 400 with `fields`)
export { httpError, type HttpErrorField } from './lib/errors.js';

// DB
export { QueryClient, createQueryClient, type BulkUpsertOptions } from './lib/db.js';

// Dialect
export type { DialectName } from './lib/dialect.js';

// Adapters
export { pgQueryable, type PgQueryable } from './lib/adapters/pg-adapter.js';
export { mysqlQueryable, type MysqlQueryable } from './lib/adapters/mysql-adapter.js';

// Table helpers
export { defineTable, buildRelation } from './lib/table-helpers.js';
export type { TableDefinition, BuildRelationOptions } from './lib/table-helpers.js';
export { Nullable } from './lib/nullable.js';

// Agent / LLM client helpers
export {
  buildAgentManifest,
  renderAgentManifestMd,
  type AgentManifest,
  type ManifestTable,
  type ManifestField,
  type ManifestJoin,
} from './lib/agent/manifest.js';
export { agentToolSchemas, type AgentToolSchemas } from './lib/agent/tool-schemas.js';

// Tenant
export { TENANT_ADMIN } from './types.js';

// SqlApi — programmatic high-level API
export { SqlApi, createSqlApi } from './lib/sql-api.js';
export type { SqlApiOptions, SqlApiSearchParams, SqlApiInsertParams, SqlApiUpdateParams, SqlApiBulkDeleteParams } from './lib/sql-api.js';


// Plugin
export { default as fastifyAutoSqlApi } from './routes/auto/plugin.js';

// Re-export deps
export { Type, type Static, type TSchema, type TObject, type TUnsafe } from 'typebox';
export { ConditionBuilder, Expression, type ConditionValueOrUndefined } from 'node-condition-builder';

// Types
export type {
  ApiRequest,
  ApiReply,
  CliConfig,
  Queryable,
  TransactionQueryable,
  SqlResult,
  DbRecord,
  DbRecordValue,
  WriteAction,
  WrittenRow,
  PrimaryKeyValue,
  SelectOptions,
  SchemaDefinition,
  JoinDefinition,
  JoinFetchRequest,
  JoinRefFilter,
  RowsByAlias,
  WriteJoinSections,
  TableConfig,
  TableOperation,
  DbTables,
  SqlApiPluginOptions,
  SwaggerOptions,
  DbErrorMapping,
  SearchResult,
  Paginator,
  ComputeFn,
  ComputeRequest,
  ComputedResult,
  PaginationResult,
  ExtendedConditionFn,
  ExtendedConditionContext,
  FilterRecord,
  AggregationRequest,
  JoinGroupRequest,
  ComputedFieldFn,
  ComputedFieldContext,
  ComputedFieldExpr,
  GetResult,
  DeleteResult,
  InsertResult,
  BulkUpsertItem,
  BulkUpsertResult,
  BulkDeleteResult,
  ConditionMethod,
  SearchCondition,
  UpdateResult,
  TenantId,
  TenantAdmin,
  TenantResolution,
  GetTenantId,
  TenantScope,
  TenantScopeDirect,
  TenantScopeIndirect,
  TenantScopeAnyOf,
  ValidationField,
  ValidateContext,
  ValidateParent,
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
  ValidatorResult,
  BulkValidatorItem,
  BulkValidatorFn,
} from './types.js';
