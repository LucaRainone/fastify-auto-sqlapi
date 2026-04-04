# fastify-auto-sqlapi

Automatic CRUD API generation from PostgreSQL tables for [Fastify](https://fastify.dev/). No ORM, no magic — just raw SQL via `pg`, with TypeBox validation and Swagger docs out of the box.

Point it at your database, and get a full REST API with search, pagination, joins, bulk operations, multi-tenant isolation, and hooks.

## Features

- **Zero boilerplate** — define your tables, get 7 endpoints each
- **No ORM** — raw SQL via `pg` + parameterized queries
- **TypeBox validation** — request/response schemas auto-generated from your DB
- **Virtual joins** — fetch related records without complex SQL
- **Bulk operations** — batch insert/upsert/delete in single queries
- **Multi-tenant** — automatic row-level isolation, zero code in handlers
- **Validation** — structured field-level validation with cross-entity support
- **Hooks** — `beforeInsert`, `beforeUpdate`, `afterInsert` for custom logic
- **Swagger UI** — optional, auto-configured from your schemas
- **Composable** — register all routes or pick only what you need

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

  // Relations
  allowedReadJoins: [
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),
  ],
  allowedWriteJoins: [
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),
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

  // Hooks (runs after validation)
  beforeInsert: async (db, req, record) => { /* record is snake_case */ },
  beforeUpdate: async (db, req, fields) => { /* fields is snake_case */ },
  afterInsert: async (db, req, record, secondaryRecords) => { /* record is camelCase */ },

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
  prefix: '/api',               // Optional — URL prefix for all routes
  swagger: true,                // Optional — enable Swagger UI (or pass SwaggerOptions)
  onRequests: [authMiddleware],  // Optional — global hooks applied to every route
  getTenantId: (req) => id,     // Optional — multi-tenant function
});
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `DbTables` | `Record<string, ITable>` | Yes | Table configurations |
| `prefix` | `string` | No | URL prefix (e.g. `/api`) |
| `swagger` | `boolean \| SwaggerOptions` | No | Enable Swagger UI |
| `onRequests` | `Function[]` | No | Global auth/middleware hooks |
| `getTenantId` | `(req) => id \| null` | No | Tenant resolver for multi-tenant |

## API Reference

### POST /search/{table}

Search with filters, pagination, ordering, joins, and aggregations.

**Request body** (all fields optional):

```json
{
  "filters": { "name": "Mario" },
  "joins": { "order": {} },
  "paginator": { "page": 1, "itemsPerPage": 20 }
}
```

**Querystring** (optional): `orderBy`, `page`, `itemsPerPage`, `computeMin`, `computeMax`, `computeSum`, `computeAvg`

**Response:**

```json
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "email": "m@test.it" }],
  "joins": { "order": [{ "id": 10, "customerId": 1, "total": 50 }] },
  "pagination": { "total": 25, "pages": 3, "paginator": { "page": 1, "itemsPerPage": 20 } }
}
```

`joins`, `joinGroups`, and `pagination` only appear when requested. A simple `{}` body returns `{ table, main }`.

### GET /rest/{table}/:id

Returns `{ main: { ... } }` or 404.

### POST /rest/{table}

**Body:**

```json
{
  "main": { "name": "Mario", "email": "m@test.it" },
  "secondaries": {
    "order": [{ "total": 50, "status": "pending" }]
  }
}
```

`secondaries` is optional. FK fields are auto-filled from the inserted main record.

**Response (201):** `{ main: { ... }, secondaries: { ... } }`

### PUT /rest/{table}

**Body:**

```json
{
  "main": { "id": 1, "name": "Updated Name" },
  "secondaries": { "order": [{ "total": 75 }] },
  "deletions": { "order": [{ "id": 10 }] }
}
```

`main` must include the primary key. `secondaries` and `deletions` are optional.

### DELETE /rest/{table}/:id

Returns the deleted record or 404.

### PUT /bulk/{table}

**Body:** Array of `{ main, secondaries?, deletions? }`. All main records are inserted/upserted in a single SQL query.

### POST /bulk/{table}/delete

**Body:** Array of objects with the PK field, e.g. `[{ "id": 1 }, { "id": 2 }]`. Executes as a single `DELETE WHERE pk IN (...)`.

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

- **camelCase in API, snake_case in DB** — the plugin converts automatically
- **Joins are virtual** — they execute separate `SELECT ... WHERE fk IN (...)` queries, not SQL JOINs
- **Hooks receive snake_case** — `beforeInsert` and `beforeUpdate` get snake_case records; `afterInsert` gets camelCase
- **All response fields are Optional** — response schemas use `Type.Partial` since `RETURNING *` may return any subset

## Re-exports

The package re-exports commonly needed utilities so you don't need to install them separately:

```typescript
import {
  Type,                   // from @sinclair/typebox
  ConditionBuilder,       // from node-condition-builder
  Expression,             // from node-condition-builder
  QueryClient,            // raw SQL query helper
  defineTable,
  exportTableInfo,
  buildRelation,
  buildUpsertRule,
  buildUpsertRules,
} from 'fastify-auto-sqlapi';
```

## Requirements

- Node.js >= 18
- PostgreSQL
- Fastify >= 4
- `@fastify/postgres` >= 5

## License

MIT
