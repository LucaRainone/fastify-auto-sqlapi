# fastify-auto-sqlapi

Automatic CRUD API generation from PostgreSQL, MySQL, and MariaDB tables for [Fastify](https://fastify.dev/). No ORM, no magic — just raw SQL, with TypeBox validation and Swagger docs out of the box.

Point it at your database, and get a full REST API with search, advanced conditions, pagination, joins, aggregations, bulk operations, multi-tenant isolation, validation, and hooks.

## Features

- **Zero boilerplate** — define your tables, get 7 endpoints each
- **No ORM** — raw SQL via `pg` + parameterized queries
- **TypeBox validation** — request/response schemas auto-generated from your DB
- **Joins** — four explicit families (`joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`) with alias support
- **Computed fields** — declare virtual fields as SQL expressions in `defineTable`; usable like schema fields in filters/orderBy/conditions, and opt-in projected in the response via `selectComputed`. Covers JSON extraction, derived columns, dialect-aware date bucketing
- **Bulk operations** — batch insert/upsert/delete in single queries
- **Multi-tenant** — automatic row-level isolation, zero code in handlers
- **Validation** — structured field-level validation with cross-entity support
- **Hooks** — full before/after matrix (insert, update, delete, bulk delete) for custom logic
- **Transactions** — insert/update with secondaries run atomically (rollback on failure)
- **Swagger UI** — optional, auto-configured from your schemas
- **Composable** — register all routes or pick only what you need

> ⚠️ **Migrating from a previous version?** The join API was redesigned. See **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** for the full migration guide.

## Quick Start

### 1. Install

```bash
npm install fastify-auto-sqlapi fastify @fastify/postgres
```

### 2. Create the config file

Create `sqlapi.config.ts` in your project root. This is used only by the CLI generators, not at runtime.

```typescript
export default {
  outputDir: './src/schemas',  // where to generate Schema files
  schema: 'public',            // PostgreSQL schema to introspect
};
```

The DB connection is read from environment variables:

```bash
# Either a full connection string:
DATABASE_URL=postgres://user:pass@localhost:5432/mydb

# Or individual vars:
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_USER=myuser
POSTGRES_PASSWORD=mypassword
POSTGRES_DB=mydb
```

### 3. Generate schemas from your database

```bash
npx sqlapi-generate-schema
```

This introspects your tables and generates one TypeBox schema file per table (e.g. `SchemaCustomer.ts`, `SchemaOrder.ts`). These files are auto-generated — don't edit them.

### 4. Generate the tables template

```bash
npx sqlapi-generate-tables
```

This creates a `tables.ts` file with a `defineTable()` call for each table. It auto-detects primary keys, foreign key relations, and lays out all available options as commented code. **This file is yours to customize.**

### 5. Register the plugin

```typescript
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';
import { dbTables } from './src/schemas/tables.js';

const app = Fastify();

await app.register(fastifyPostgres, {
  connectionString: 'postgres://user:pass@localhost:5432/mydb',
});

await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  swagger: true,
  prefix: '/api',
});

await app.listen({ port: 3000 });
```

That's it. For a table called `customer`, you now have:

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/search/customer` | Search with filters, pagination, joins |
| `GET` | `/api/rest/customer/:id` | Get a single record by primary key |
| `POST` | `/api/rest/customer` | Insert a new record |
| `PUT` | `/api/rest/customer` | Update a record |
| `DELETE` | `/api/rest/customer/:id` | Delete a record |
| `PUT` | `/api/bulk/customer` | Bulk upsert (array of records) |
| `POST` | `/api/bulk/customer/delete` | Bulk delete (array of PKs) |

> **Note:** Search uses `POST` because filters are passed as JSON in the request body.

## Table Configuration

Tables are configured with `defineTable()`. The only required fields are `primary` and the output of `exportTableInfo()`:

```typescript
import { defineTable, exportTableInfo } from 'fastify-auto-sqlapi';
import { SchemaCustomer } from './SchemaCustomer.js';

const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),
});
```

`exportTableInfo()` provides the schema, a filter builder (auto-generates WHERE clauses from request fields), and extra filter definitions.

Export all your tables as a single record:

```typescript
export const dbTables = {
  customer: TableCustomer,
  order: TableOrder,
};
```

The keys in this record (`customer`, `order`) become the table names in the URL paths.

### All available options

```typescript
const TableCustomer = defineTable({
  // Required
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),

  // Ordering & filtering
  defaultOrder: 'name',                     // default ORDER BY
  excludeFromCreation: ['id'],              // omit from INSERT (e.g. auto-increment)
  distinctResults: true,                    // SELECT DISTINCT

  // Relations — alias defaults to joinSchema.tableName. Override with `{ alias: '...' }`
  // when you join the same table twice (e.g. `createdBy`/`updatedBy`) or want a friendlier
  // name. Set `unique: true` for N:1 (parent) relations to enable `joinLeft`.
  allowedReadJoins: [
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),                       // alias = 'order'
    buildRelation(SchemaSession, 'userId', SchemaUser, 'id', { unique: true }),           // alias = 'user', N:1
    buildRelation(SchemaSession, 'updatedBy', SchemaUser, 'id', { alias: 'updater', unique: true }),
  ],
  allowedWriteJoins: [
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),                       // alias = 'order'
  ],

  // Upsert (ON CONFLICT)
  upsertMap: buildUpsertRules(
    buildUpsertRule(SchemaCustomer, ['id']),
  ),

  // Schema overrides (tighten generated schema without editing Schema files)
  schemaOverrides: {
    email: Type.String({ format: 'email' }),
  },

  // Multi-tenant isolation
  tenantScope: { column: 'organization_id' },

  // Validation (runs after schema validation, before hooks)
  validate: async (db, req, main, secondaries) => {
    // Return ValidationError[] — tuple: [field, code] or [field, code, message]
    // message defaults to code if omitted
    if (!main.name) return [['name', 'required']];
    return [];
  },
  validateBulk: async (db, req, items) => {
    // Bulk-upsert only. Called once with all items for cross-item validation.
    return [];
  },

  // Hooks (run after validation) — all receive camelCase records (schema field names).
  // after* hooks for insert/update run INSIDE the write transaction: throwing rolls back.
  beforeInsert: async (db, req, record) => { /* camelCase; mutations propagate to INSERT */ },
  afterInsert: async (db, req, record, secondaryRecords) => { /* camelCase; input merged with generated PK */ },
  beforeUpdate: async (db, req, fields) => { /* camelCase; PK included for reference, excluded from UPDATE SET */ },
  afterUpdate: async (db, req, record, secondaryRecords, deletionRecords) => { /* after UPDATE + secondaries + deletions */ },
  beforeDelete: async (db, req, id) => { /* throw to abort the deletion */ },
  afterDelete: async (db, req, id) => { /* after a successful single delete */ },
  beforeBulkDelete: async (db, req, ids) => { /* called ONCE with all ids; throw to abort the batch */ },
  afterBulkDelete: async (db, req, deletedIds) => { /* called ONCE with the ids ACTUALLY deleted */ },

  // Auth (per-table)
  onRequests: [
    async (request, reply) => {
      if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    },
  ],
});
```

### Custom filters (extraFilters)

For filters that don't map to real columns (e.g. a search `q` field):

```typescript
import { Type, ConditionBuilder } from 'fastify-auto-sqlapi';

const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(
    SchemaCustomer,
    { q: Type.Optional(Type.String()) },       // extra filter definition
    (condition, filters) => {                   // custom condition builder
      if (filters.q) {
        const or = new ConditionBuilder('OR');
        or.isILike('name', `%${filters.q}%`);
        or.isILike('email', `%${filters.q}%`);
        condition.append(or);
      }
    }
  ),
});
```

## Plugin Options

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,           // Required — your table definitions
  dialect: 'postgres',          // Optional — 'postgres' | 'mysql' | 'mariadb' (default: 'postgres')
  prefix: '/api',               // Optional — URL prefix for all routes
  swagger: true,                // Optional — enable Swagger UI (or pass SwaggerOptions)
  onRequests: [authMiddleware],  // Optional — global hooks applied to every route
  getTenantId: (req) => id,     // Optional — multi-tenant function
  debug: true,                  // Optional — log all SQL queries and params
});
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `DbTables` | `Record<string, ITable>` | Yes | Table configurations |
| `dialect` | `'postgres' \| 'mysql' \| 'mariadb'` | No | DB dialect (default: `'postgres'`) |
| `prefix` | `string` | No | URL prefix (e.g. `/api`) |
| `swagger` | `boolean \| SwaggerOptions` | No | Enable Swagger UI |
| `onRequests` | `Function[]` | No | Global auth/middleware hooks |
| `getTenantId` | `(req) => id \| null` | No | Tenant resolver for multi-tenant |
| `debug` | `boolean` | No | Log all SQL queries to console |

For MySQL/MariaDB, register `mysql2/promise` pool instead of `@fastify/postgres` and pass `dialect: 'mysql'` or `'mariadb'`.

## Security

> ⚠️ **The plugin is open by default.** Registering it without any configuration exposes
> **all operations on all tables in `DbTables`** (read AND write, including bulk delete) to
> anyone who can reach the server. This is intentional — the plugin provides the tools and
> does not impose an auth model — but it means **you** are responsible for locking it down
> before exposing it.

Three layers are available, combinable:

**1. Authentication / authorization hooks** — `onRequests` runs before every auto-generated
route (globally or per table):

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  onRequests: [async (request, reply) => {
    await request.jwtVerify(); // or any auth check; throw/reply to block
  }],
});
```

**2. Per-table operation whitelist** — `operations` limits which routes are registered for a
table. Omitted = all operations (default). Unlisted operations are not registered at all
(they answer 404):

```typescript
const TableAuditLog = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaAuditLog),
  operations: ['search', 'get'], // read-only over HTTP: no insert/update/delete/bulk
});
```

Note: `operations` gates the HTTP routes only. The programmatic `fastify.sqlApi.*` methods
are always available to your own code.

**3. Multi-tenancy** — `getTenantId` + `tenantScope` filter every query by tenant (see
[Multi-Tenant](#multi-tenant)).

## API Reference

### POST /search/{table}

Search with filters, advanced conditions, pagination, ordering, joins, and aggregations.

**Request body** (all fields optional):

```json
{
  "filters": { "name": "Mario" },
  "conditions": [
    { "field": "total", "method": "isGreater", "params": [100] },
    { "field": "createdAt", "method": "isBetween", "params": ["2024-01-01", "2024-12-31"] }
  ],
  "joinMustExist": {
    "orders": {
      "filters": { "status": "completed" },
      "conditions": [{ "field": "total", "method": "isGreater", "params": [50] }]
    }
  },
  "joinMultiple": {
    "orders": {
      "filters": { "status": "completed" },
      "selection": "id,total,status"
    }
  },
  "joinGroup": {
    "orders": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "min": ["total"],
        "max": ["total"],
        "avg": ["total"],
        "count": ["id"],
        "distinctCount": ["status"]
      },
      "filters": { "status": "completed" }
    }
  },
  "joinLeft": {
    "creator": { "selection": "id,name,email" }
  }
}
```

- **`filters`** — equality-based, flat key/value. Supports schema fields + `extraFilters`.
- **`conditions`** — array of `{ field, method, params }`. Methods: `isEqual`, `isNotEqual`, `isGreater`, `isGreaterOrEqual`, `isLess`, `isLessOrEqual`, `isLike`, `isILike`, `isIn`, `isNotIn`, `isBetween`, `isNotBetween`, `isNull`, `isNotNull`.
- **`joinMustExist`** — EXISTS-based filter: "main rows where at least one related row matches". Accepts `{ filters, conditions }` (both optional). Aliases must come from `allowedReadJoins` declarations with `unique: false`.
- **`joinMultiple`** — fetches related child rows in a side query. Accepts `{ filters, conditions, selection }`. Same `unique: false` aliases.
- **`joinGroup`** — aggregations on the related table. Supports `sum`, `min`, `max`, `avg`, `count`, `distinctCount`, and optional `by` for GROUP BY (a schema field name or a computed-field name declared on the join table — e.g. for date bucketing declare a computed using `db.dateTrunc('month', qiCol('orderDate'))`). Accepts `{ filters, conditions }`. Same `unique: false` aliases.
- **`joinLeft`** — embeds an N:1 parent. Real `LEFT JOIN` is added on demand (only when the request has `filters`/`conditions` on the parent or uses 2-parti `orderBy` on this alias). Aliases must be declared with `unique: true`. Accepts `{ filters, conditions, selection }`.

**Dot-notation in `orderBy` and `conditions`**:

| Form | Source | Example |
|------|--------|---------|
| `<field>` | main schema | `orderBy=name ASC` |
| `<alias>.<field>` | `joinLeft` aliases (`unique: true`) | `orderBy=creator.name ASC` |
| `<alias>.<fn>.<field>` | `joinGroup` aliases declared in the same body | `orderBy=orders.sum.total DESC`, or `conditions: [{ field: 'orders.count.id', method: 'isGreaterOrEqual', params: [4] }]` |

**Querystring** (optional): `orderBy`, `page`, `itemsPerPage`, `computeMin`, `computeMax`, `computeSum`, `computeAvg`

**Response:**

```json
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "email": "m@test.it" }],
  "joinLeft":     { "creator": [{ "id": 7, "name": "Alice", "email": "a@x.it" }] },
  "joinMultiple": { "orders":  [{ "id": 10, "customerId": 1, "total": 50 }] },
  "joinGroup": {
    "orders": {
      "sum": { "total": 300 },
      "count": { "id": 2 },
      "rows": [{ "by": "completed", "sum_total": 300, "count_id": 2 }]
    }
  },
  "pagination": {
    "total": 25,
    "pages": 3,
    "computed": { "min": { "id": 1 }, "max": { "id": 100 } },
    "paginator": { "page": 1, "itemsPerPage": 20 }
  }
}
```

`joinLeft`, `joinMultiple`, `joinGroup`, and `pagination` appear only when requested. A simple `{}` body returns `{ table, main }`. `pagination.computed` appears only if `computeMin`/`computeMax`/`computeSum`/`computeAvg` are used.

### GET /rest/{table}/:id

Returns `{ main: { ... } }` or 404.

### POST /rest/{table}

**Body:**

```json
{
  "main": { "name": "Mario", "email": "m@test.it" },
  "secondaries": {
    "orders": [{ "total": 50, "status": "pending" }]
  }
}
```

`secondaries` keys are the **alias** declared in `allowedWriteJoins`. FK fields are auto-filled from the inserted main record.

> **Owned child tables (translations, `*_info` details): use a writeJoin, not a standalone table.**
> A table that only exists as a child of a parent — e.g. `product_info` with composite PK `(product_id, lang)` — should be an `allowedWriteJoins` on the parent, not its own `DbTables` entry. The engine auto-fills the FK (`product_id`); add it to `upsertMap` (conflict key = the composite PK) to upsert children passing only their own fields:
> ```typescript
> // on the parent (product) table:
> allowedWriteJoins: [
>   buildRelation(SchemaProduct, 'id', SchemaProductInfo, 'productId', { alias: 'translations' }),
> ],
> upsertMap: buildUpsertRules(
>   buildUpsertRule(SchemaProductInfo, ['productId', 'lang']),  // composite conflict key
> ),
> // → PUT /rest/product { "main": {...}, "secondaries": { "translations": [{ "lang": "en", "name": "Bike" }] } }
> ```
> Expose a composite-PK table as a standalone CRUD table only when it stands on its own (M:N link tables, natural keys) — composite PKs are fully supported there too.

**Response (201):** `{ main: { ... }, secondaries: { ... } }`

### PUT /rest/{table}

**Body:**

```json
{
  "main": { "id": 1, "name": "Updated Name" },
  "secondaries": { "orders": [{ "total": 75 }] },
  "deletions":   { "orders": [{ "id": 10 }] }
}
```

`main` must include the primary key. `secondaries` and `deletions` are optional.

### DELETE /rest/{table}/:id

Returns the deleted record or 404.

### PUT /bulk/{table}

**Body:** Array of `{ main, secondaries?, deletions? }`. All main records are inserted/upserted in a single SQL query.

### POST /bulk/{table}/delete

**Body:** Array of objects with the PK field, e.g. `[{ "id": 1 }, { "id": 2 }]`. Executes as a single `DELETE WHERE pk IN (...)`.

### Validation errors (400)

Both schema-level (TypeBox/Ajv) and custom (`validate` / `validateBulk`) errors use the same response shape:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "fields": [
    { "path": "main.email", "code": "format", "message": "must match format \"email\"" },
    { "path": "name", "code": "required", "message": "is required" }
  ]
}
```

Custom validators return tuples `[field, code]` or `[field, code, message]` — `message` defaults to `code` if omitted. `validateBulk` replaces per-item `validate` in bulk-upsert requests.

## Multi-Tenant

Automatic row-level isolation on all CRUD operations. Configure once, no code in handlers.

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  getTenantId: (request) => request.user?.organizationId ?? null,
});
```

When `getTenantId` returns `null`, no filtering is applied (admin mode).

### Direct tenant (column on the table)

```typescript
defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),
  tenantScope: { column: 'organization_id' },
});
```

### Indirect tenant (via parent table)

```typescript
defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaOrder),
  tenantScope: {
    column: 'organization_id',
    through: { schema: SchemaCustomer, localField: 'customer_id', foreignField: 'id' },
  },
});
```

Tables without `tenantScope` are unaffected.

## Swagger

Enabled by passing `swagger: true` (or a config object) to the plugin options. Requires `@fastify/swagger` and `@fastify/swagger-ui` as peer dependencies.

```bash
npm install @fastify/swagger @fastify/swagger-ui
```

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  swagger: {
    title: 'My API',
    description: 'Auto-generated CRUD API',
    version: '1.0.0',
    routePrefix: '/docs',
  },
});
```

If the swagger packages are not installed, the plugin logs a warning and continues without Swagger.

## Granular Composition

Instead of registering the all-in-one plugin, you can register individual route plugins for more control:

```typescript
import {
  searchRoutes, getRoutes, insertRoutes, updateRoutes,
  deleteRoutes, bulkUpsertRoutes, bulkDeleteRoutes, setupSwagger,
} from 'fastify-auto-sqlapi';

// Read-only API
await app.register(async (instance) => {
  await setupSwagger(instance, { swagger: true });
  const opts = { DbTables: dbTables };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
}, { prefix: '/public' });

// Full CRUD with auth
await app.register(async (instance) => {
  const opts = { DbTables: dbTables, onRequests: [authMiddleware] };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(insertRoutes, opts);
  await instance.register(updateRoutes, opts);
  await instance.register(deleteRoutes, opts);
  await instance.register(bulkUpsertRoutes, opts);
  await instance.register(bulkDeleteRoutes, opts);
}, { prefix: '/admin' });
```

## Conventions

- **camelCase everywhere in the API** — requests, responses, `validate`, and all hooks (`beforeInsert`/`afterInsert`, `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`, `beforeBulkDelete`/`afterBulkDelete`) use schema field names
- **Conversion to DB column format is automatic** via `colMap` — supports both snake_case and camelCase DB columns (e.g. betterauth-style)
- **Aliases identify joins** — declared in `buildRelation({ alias })`, used as keys in request/response/`secondaries`/dotted notation
- **`joinMustExist` / `joinMultiple` / `joinGroup`** are 1:N (child→main) and use side queries / EXISTS / correlated subqueries — no row duplication
- **`joinLeft`** is N:1 (parent→main) and adds a real `LEFT JOIN` on demand (only when filtering/ordering by parent)
- **All response fields are Optional** — response schemas use `Type.Partial` since `RETURNING *` may return any subset

## Re-exports

The package re-exports commonly needed utilities so you don't need to install them separately:

```typescript
import {
  Type,                   // from @sinclair/typebox
  type Static,            // from @sinclair/typebox
  ConditionBuilder,       // from node-condition-builder
  Expression,             // from node-condition-builder

  // Table configuration
  defineTable,
  exportTableInfo,
  buildRelation,
  buildUpsertRule,
  buildUpsertRules,

  // DB layer
  QueryClient,            // raw SQL query helper
  createQueryClient,      // factory with dialect string
  pgQueryable,            // pg pool adapter
  mysqlQueryable,         // mysql2 pool adapter

  // Programmatic high-level API
  createSqlApi,           // standalone SqlApi (for scripts/tests)
  setupSwagger,           // manual Swagger registration
} from 'fastify-auto-sqlapi';

import type {
  ValidationError,        // [field, code] | [field, code, message]
  ValidatorFn,
  BulkValidatorFn,
  JoinDefinition,
  JoinRefFilter,
  JoinFetchRequest,
  JoinGroupRequest,
  SearchCondition,
  ConditionMethod,
} from 'fastify-auto-sqlapi';
```

After registering the plugin, `app.sqlApi` is decorated on the Fastify instance and exposes `search`, `get`, `insert`, `update`, `delete`, `bulkUpsert`, `bulkDelete` for custom routes — same code path as the auto-generated endpoints.

## Requirements

- Node.js >= 18
- Fastify >= 4 (peer dependency)
- One of:
  - **PostgreSQL** + `pg` + `@fastify/postgres`
  - **MySQL** / **MariaDB** + `mysql2`
- Optional: `@fastify/swagger` + `@fastify/swagger-ui` for Swagger UI

## License

MIT
