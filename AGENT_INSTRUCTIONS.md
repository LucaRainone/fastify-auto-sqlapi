# fastify-auto-sqlapi — Agent Instructions

You are configuring a Fastify server that uses `fastify-auto-sqlapi` to auto-generate CRUD APIs from database tables. Follow these instructions precisely.

## Overview

The plugin generates REST endpoints (search, get, insert, update, delete, bulk upsert, bulk delete) from database table definitions. No ORM — raw SQL. Supports **PostgreSQL**, **MySQL**, and **MariaDB**. The consumer defines table configurations, and the plugin handles routing, validation, and query execution.

## Setup Workflow

### 1. Install

```bash
npm install fastify-auto-sqlapi
# PostgreSQL:
npm install fastify @fastify/postgres
# MySQL/MariaDB:
npm install fastify mysql2
# Optional (for Swagger UI):
npm install @fastify/swagger @fastify/swagger-ui
```

### 2. Configure `sqlapi.config.ts` (CLI only)

Create `sqlapi.config.ts` (or `.js`) in the project root. This config is used **only by the CLI** (`sqlapi-generate-schema` / `sqlapi-generate-tables`), NOT at runtime by the Fastify plugin.

```typescript
// sqlapi.config.ts — interface: { outputDir: string; schema?: string; dialect?: DialectName }
export default {
  outputDir: './src/db',       // base directory for generated files (default: './src/db')
  schema: 'public',            // DB schema to introspect (default: 'public', PostgreSQL only)
  dialect: 'postgres',         // 'postgres' | 'mysql' | 'mariadb' (default: 'postgres')
};
```

That's it — only these three fields exist. **No connection string, no migration path.** If the file is missing, defaults are used. The `dialect` can also be passed via CLI flag `--dialect mysql`.

### 3. Configure database connection (env vars)

The CLI reads DB connection from environment variables (NOT from the config file). `DATABASE_URL` takes priority for all dialects.

**PostgreSQL:**
- `DATABASE_URL` — full connection string, OR:
- `POSTGRES_HOST` (default: `127.0.0.1`), `POSTGRES_PORT` (default: `5433`), `POSTGRES_USER` (default: `test`), `POSTGRES_PASSWORD` (default: `test`), `POSTGRES_DB` (default: `testdb`)

**MySQL/MariaDB:**
- `DATABASE_URL` — full connection string, OR:
- `MYSQL_HOST` (default: `127.0.0.1`), `MYSQL_PORT` (default: `3306`), `MYSQL_USER` (default: `test`), `MYSQL_PASSWORD` (default: `test`), `MYSQL_DB` (default: `testdb`)

The CLI automatically loads a `.env` file from the current working directory (if it exists). Variables already set in the environment are not overridden.

```
# .env
DATABASE_URL=postgres://user:pass@localhost:5432/mydb
```

```json
"scripts": {
  "sqlapi:generate-schema": "sqlapi-generate-schema",
  "sqlapi:generate-tables": "sqlapi-generate-tables --all"
}
```

At runtime, the Fastify plugin uses `@fastify/postgres` (for PG) or `mysql2` (for MySQL/MariaDB) which you configure separately (see step 6).

### 4. Generate Schema files

```bash
npx sqlapi-generate-schema                # PostgreSQL (default)
npx sqlapi-generate-schema --dialect mysql # MySQL/MariaDB
```

This introspects the database and generates one `Schema*.ts` file per table in `outputDir/schemas/`. These files are auto-generated and should not be manually edited. They contain TypeBox field definitions, `col()` for camelCase→snake_case mapping, and validation schemas. MySQL/MariaDB requires `mysql2` as a peer dependency.

### 5. Generate tables template

```bash
npx sqlapi-generate-tables customer customer_order   # specific tables (space separated)
npx sqlapi-generate-tables customer,customer_order    # specific tables (comma separated)
npx sqlapi-generate-tables --all                      # all tables
```

This reads the Schema files from `outputDir/schemas/` and generates one `Table*.ts` file per table plus a `dbTables.ts` index in `outputDir/tables/`:

```
src/db/
  schemas/
    SchemaCustomer.ts        # from generate-schema (do not edit)
    SchemaCustomerOrder.ts
  tables/
    TableCustomer.ts         # generated — skip if already exists
    TableCustomerOrder.ts
    dbTables.ts              # always regenerated (import + export map)
```

Each `Table*.ts` file contains a `defineTable()` call with:
- Auto-detected primary keys
- Auto-detected foreign key relations (from field naming convention `*Id`)
- All optional keys as commented code, ready to uncomment
- `export default TableXxx`

`dbTables.ts` is always regenerated to include all schemas (not just the requested ones). Individual `Table*.ts` files are **never overwritten** — if they already exist, they are skipped. This makes it safe to re-run the command when new tables are added to the database.

**Edit the `Table*.ts` files to customize** — these files are yours to maintain.

### 6. Create the Fastify server

**PostgreSQL setup:**

```typescript
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';
import { dbTables } from './src/db/tables/dbTables.js';

const app = Fastify();

await app.register(fastifyPostgres, {
  connectionString: 'postgres://user:pass@localhost:5432/mydb',
});

await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,          // REQUIRED — Record<string, ITable>
  // dialect: 'postgres',      // optional — default is 'postgres'
  swagger: true,               // optional — true or SwaggerOptions object
  prefix: '/auto',             // optional — standard Fastify prefix
  onRequests: [],              // optional — global auth hooks (run on every route)
  getTenantId: (request) => request.user?.organizationId ?? null, // optional — multi-tenant
});

await app.listen({ port: 3000 });
```

**MySQL/MariaDB setup:**

```typescript
import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import { fastifyAutoSqlApi, mysqlQueryable } from 'fastify-auto-sqlapi';
import { dbTables } from './src/db/tables/dbTables.js';

const app = Fastify();

const pool = mysql.createPool({
  host: '127.0.0.1', port: 3306,
  user: 'root', password: 'pass', database: 'mydb',
});
app.decorate('mysql', pool);

await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  dialect: 'mysql',            // or 'mariadb' (MariaDB supports RETURNING)
  swagger: true,
  prefix: '/auto',
});

await app.listen({ port: 3000 });
```

**Granular composition (any dialect):**

```typescript
import {
  searchRoutes, getRoutes, insertRoutes, updateRoutes,
  deleteRoutes, bulkUpsertRoutes, bulkDeleteRoutes, setupSwagger,
} from 'fastify-auto-sqlapi';

await app.register(async (instance) => {
  await setupSwagger(instance, { swagger: true });

  const opts = { DbTables: dbTables, dialect: 'mysql' };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(insertRoutes, opts);
  await instance.register(updateRoutes, opts);
  await instance.register(deleteRoutes, opts);
  await instance.register(bulkUpsertRoutes, opts);
  await instance.register(bulkDeleteRoutes, opts);
}, { prefix: '/auto' });
```

### Generated endpoints

The plugin defines routes with these base paths: `/search/`, `/rest/`, `/bulk/`. The prefix from `register()` is prepended by Fastify. For a table `customer` with `prefix: '/auto'`:

```
POST   /auto/search/customer           — search with filters in body
GET    /auto/rest/customer/:id         — get single record by PK
POST   /auto/rest/customer             — insert record (+ secondaries)
PUT    /auto/rest/customer             — update record (+ secondaries + deletions)
DELETE /auto/rest/customer/:id         — delete record by PK
PUT    /auto/bulk/customer             — bulk upsert (array of items)
POST   /auto/bulk/customer/delete      — bulk delete (array of PKs)
```

Without prefix, routes are at root: `/search/customer`, `/rest/customer/:id`, etc.

**Important**: Search uses `POST` (not GET) because filters are passed in the request body as JSON.

---

## defineTable() — Complete Reference

```typescript
import {
  Type,
  exportTableInfo,
  defineTable,
  buildRelation,
  buildUpsertRules,
  buildUpsertRule,
  ConditionBuilder,
} from 'fastify-auto-sqlapi';
import type { DbTables } from 'fastify-auto-sqlapi';
```

### Minimal table

```typescript
const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),
});
```

`exportTableInfo(Schema)` returns `{ Schema, filters, extraFilters }`. The `filters` function auto-builds WHERE conditions from any schema field present in the request.

**Important**: there is no `tableName` key in `defineTable()`. The SQL table name comes from `Schema.tableName` (set by the CLI). The route URL name is the key you use in the `dbTables` record (e.g. `{ customer: TableCustomer }` → `/search/customer`).

### All keys

```typescript
const TableCustomer = defineTable({
  // REQUIRED
  primary: 'id',                          // PK field name (camelCase)
  ...exportTableInfo(SchemaCustomer),     // Schema + auto-filter builder

  // OPTIONAL
  defaultOrder: 'name',                   // ORDER BY default (supports multi: 'name ASC, id DESC')
  excludeFromCreation: ['id'],            // Fields omitted from INSERT (e.g. auto-increment PK)
  distinctResults: true,                  // Use SELECT DISTINCT

  // JOINS — relations to other tables
  allowedReadJoins: [                     // Available for search queries
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),
    buildRelation(SchemaCustomer, 'id', SchemaAddress, 'customerId', 'id, city, zip'),
  ],
  allowedWriteJoins: [                    // Available for insert/update secondaries
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),
  ],

  // UPSERT — ON CONFLICT resolution
  upsertMap: buildUpsertRules(
    buildUpsertRule(SchemaCustomer, ['id']),          // main table conflict key
    buildUpsertRule(SchemaOrder, ['id']),              // secondary conflict key
  ),

  // TENANT — automatic row-level isolation
  tenantScope: { column: 'organization_id' },   // direct: column on this table
  // OR indirect: resolve via JOIN to parent table
  // tenantScope: {
  //   column: 'organization_id',
  //   through: { schema: SchemaCustomer, localField: 'customerId', foreignField: 'id' },
  // },

  // HOOKS
  beforeInsert: async (db, req, record) => {
    // Mutate record before INSERT. record is snake_case.
    record.created_by = req.user.id;
  },
  afterInsert: async (db, req, record, secondaryRecords) => {
    // Called after INSERT + secondaries. record is camelCase.
  },
  beforeUpdate: async (db, req, fields) => {
    // Mutate fields before UPDATE. fields is snake_case.
    fields.updated_by = req.user.id;
  },

  // AUTH — per-table request hooks
  onRequests: [
    async (request, reply) => {
      if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    },
  ],
});
```

### buildRelation signature

```typescript
buildRelation(mainSchema, mainField, joinSchema, joinField, selection?)
```

- `mainField`: field(s) in main table (string or string[])
- `joinField`: field in join table that references the main
- `selection`: SQL columns to select (default `'*'`), e.g. `'id, name, total'`

The join works as: `SELECT {selection} FROM {joinTable} WHERE {joinField} IN ({mainField values})`

### extraFilters + extendedCondition

For filters that don't map to real columns (e.g. full-text search `q`):

```typescript
const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(
    SchemaCustomer,
    // Extra filter fields (appear in Swagger, not auto-applied)
    { q: Type.Optional(Type.String()) },
    // Custom condition builder
    (condition, filters) => {
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

`extraFilters` fields are NOT auto-applied as `WHERE col = value`. They are handled exclusively by the `extendedCondition` callback.

---

## API Endpoints — Request/Response Shapes

### POST /search/{tableName}

**Body:**

```json
{
  "filters": { "name": "Mario", "q": "search term" },
  "orderBy": "name ASC, id DESC",
  "paginator": { "page": 1, "itemsPerPage": 20 },
  "computeMin": "id",
  "computeMax": "id",
  "joins": {
    "customer_order": { "filters": { "status": "pending" } }
  },
  "joinGroups": {
    "customer_order": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "min": ["total"],
        "max": ["total"],
        "distinctCount": ["status"]
      },
      "filters": { "status": "active" }
    }
  }
}
```

All fields are optional. An empty body `{}` returns all records.

**Response:**

```json
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "email": "m@t.it" }],
  "joins": {
    "customer_order": [{ "id": 10, "customerId": 1, "total": 50 }]
  },
  "joinGroups": {
    "customer_order": {
      "sum": { "total": 150 },
      "rows": [{ "by": "pending", "sum_total": 100 }]
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

`joins`, `joinGroups`, `pagination` appear ONLY if requested. A simple search returns just `{ table, main }`.

### GET /rest/{tableName}/:id

**Response (200):**

```json
{ "main": { "id": 1, "name": "Mario", "email": "m@t.it" } }
```

Returns 404 if not found.

### POST /rest/{tableName}

**Body:**

```json
{
  "main": { "name": "Mario", "email": "m@t.it" },
  "secondaries": {
    "customer_order": [
      { "total": 50, "status": "pending" }
    ]
  }
}
```

`secondaries` is optional. FK fields (e.g. `customerId` in orders) are auto-filled from the inserted main record.

**Response (201):**

```json
{
  "main": { "id": 1, "name": "Mario", "email": "m@t.it" },
  "secondaries": {
    "customer_order": [{ "id": 10, "customerId": 1, "total": 50, "status": "pending" }]
  }
}
```

### PUT /rest/{tableName}

**Body:**

```json
{
  "main": { "id": 1, "name": "Mario Updated", "email": "new@t.it" },
  "secondaries": {
    "customer_order": [{ "total": 75, "status": "shipped" }]
  },
  "deletions": {
    "customer_order": [{ "id": 10 }]
  }
}
```

`main` MUST include the PK. `secondaries` and `deletions` are optional.

**Response (200):** Same shape as insert response, with `deletions` count if requested.

### DELETE /rest/{tableName}/:id

**Response (200):**

```json
{ "main": { "id": 1, "name": "Mario", "email": "m@t.it" } }
```

Returns the deleted record. 404 if not found.

### PUT /bulk/{tableName}

**Body:**

```json
[
  {
    "main": { "name": "Mario", "email": "m@t.it" },
    "secondaries": { "customer_order": [{ "total": 50 }] },
    "deletions": { "customer_order": [{ "id": 99 }] }
  },
  {
    "main": { "name": "Luigi", "email": "l@t.it" }
  }
]
```

All main records are inserted/upserted in a single SQL query. Secondaries and deletions are processed per-item.

**Response (200):** Array of `{ main, secondaries?, deletions? }`.

### POST /bulk/{tableName}/delete

**Body:**

```json
[{ "id": 1 }, { "id": 2 }, { "id": 3 }]
```

Each object must contain the PK field. All deletions execute as a single `DELETE WHERE pk IN (...)`.

**Response (200):** Array of `{ main }` with deleted records.

---

## ConditionBuilder API

Used in `extendedCondition` callbacks and hooks:

```typescript
const cb = new ConditionBuilder('AND');  // or 'OR'
cb.isEqual('column', value);
cb.isLike('column', '%value%');
cb.isILike('column', '%value%');         // case-insensitive LIKE
cb.isBetween('column', from, to);
cb.isIn('column', [val1, val2]);
cb.isNull('column');
cb.isGreater('column', value);
cb.raw('column::text = $1', [value]);    // raw SQL with params
cb.append(otherConditionBuilder);        // nest conditions
```

All values are parameterized (`$1, $2, ...`), never interpolated.

---

## QueryClient API

Available in hooks via the `db` parameter:

```typescript
db.insert(tableName, record);                              // INSERT RETURNING *
db.insertOrUpdate(tableName, record, conflictKeys);        // INSERT ON CONFLICT
db.bulkInsert(tableName, records, chunkSize?);             // Multi-row INSERT
db.bulkInsertOrUpdate(tableName, records, conflictKeys);   // Multi-row UPSERT
db.update(tableName, record, where, condition?, options?);  // UPDATE RETURNING *
db.delete(tableName, where);                                // DELETE RETURNING *
db.select({ tableName, columns?, where, values, limit?, orderBy? });
db.query(sql, values);                                      // Raw query
db.expression(value);                                       // Raw SQL expression (not parameterized)
```

Record keys are snake_case column names. Values are parameterized.

---

## Swagger

```typescript
import { setupSwagger } from 'fastify-auto-sqlapi';

// Basic (UI at /documentation)
await setupSwagger(instance, { swagger: true });

// Custom
await setupSwagger(instance, {
  swagger: {
    title: 'My API',
    description: 'Auto-generated CRUD API',
    version: '1.0.0',
    routePrefix: '/docs',
  },
});
```

Requires `@fastify/swagger` and `@fastify/swagger-ui` as peer deps. If not installed, logs a warning and continues.

---

## Key Conventions

- **camelCase in API, snake_case in DB**: all request/response fields are camelCase. The plugin converts automatically via `col()`.
- **All fields Optional in response**: `RETURNING *` may return any subset. Response schemas use `Type.Partial`.
- **Joins are virtual**: not SQL JOINs. They execute separate `SELECT ... WHERE fk IN (...)` queries.
- **`excludeFromCreation`**: fields like auto-increment PKs are stripped from INSERT bodies. They still appear in responses.
- **`upsertMap`**: when present for a schema, INSERT becomes upsert. PostgreSQL: `ON CONFLICT (...) DO UPDATE`. MySQL/MariaDB: `ON DUPLICATE KEY UPDATE`. Applies to both main and secondary tables.
- **Hooks receive snake_case**: `beforeInsert` and `beforeUpdate` receive snake_case records (pre-DB). `afterInsert` receives camelCase (post-DB).
- **Filters validation**: TypeBox schemas use `additionalProperties: false`. By default Fastify strips unknown fields silently. For 400 errors on unknown filters: `Fastify({ ajv: { customOptions: { removeAdditional: false } } })`.
- **Tenant filtering**: when `tenantScope` is set on a table and `getTenantId` is provided in plugin options, all CRUD operations are automatically scoped to the tenant. `getTenantId` returning `null`/`undefined` = admin (no filter). Returning an array = multi-tenant user (IN clause).

---

## Multi-Tenant Filtering

Automatic row-level isolation per tenant on all CRUD operations. Zero code in route handlers — just configure and go.

### Setup

```typescript
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';

await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  // Return tenant ID(s) from request. null/undefined = admin (no filter).
  getTenantId: (request) => {
    const orgId = request.user?.organizationId;
    return orgId ?? null;
  },
});
```

### Direct tenant (column on the table itself)

```typescript
const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),
  tenantScope: { column: 'organization_id' },
});
```

Behavior:
- **Read** (search, get, delete, bulk-delete): adds `AND organization_id IN ($N)` to WHERE
- **Insert**: auto-injects `organization_id` if single tenant; validates if already present (403 if mismatch); 400 if multi-tenant without explicit value
- **Update**: strips `organization_id` from SET (can't change tenant), adds to WHERE condition
- **Bulk upsert**: auto-injects on all records

### Indirect tenant (via JOIN to parent table)

```typescript
const TableOrder = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaOrder),
  tenantScope: {
    column: 'organization_id',
    through: {
      schema: SchemaCustomer,        // parent table schema
      localField: 'customer_id',     // FK on this table
      foreignField: 'id',            // PK on parent table
    },
  },
});
```

Behavior:
- **Read**: INNER JOIN to parent table + WHERE on parent's tenant column
- **Insert/Bulk upsert**: validates FK references belong to tenant (1 batch query)
- **Update**: pre-check via SELECT with INNER JOIN (404 if not found)
- **Delete**: subquery `DELETE WHERE pk IN (SELECT ... INNER JOIN ... WHERE tenant IN (...))`

### Multi-tenant users

```typescript
getTenantId: (request) => {
  // Return array for users managing multiple tenants
  return request.user?.organizationIds ?? null; // e.g. [1, 2, 3]
},
```

Uses `IN ($N, $M, ...)` for all WHERE clauses (same as single tenant, just with more values).

### Admin bypass

When `getTenantId` returns `null` or `undefined`, no filtering is applied (full access).

### Tables without tenant

Tables without `tenantScope` are unaffected — no filtering regardless of `getTenantId` result.

### Error codes

- **403** — Record doesn't belong to tenant, or explicit tenant value doesn't match
- **400** — Multi-tenant user on insert without explicit tenant value (ambiguous)
- **404** — Update with indirect tenant, record not found for this tenant

---

## Common Patterns

### Auth middleware (global)

```typescript
const opts = {
  DbTables: dbTables,
  onRequests: [async (req, reply) => {
    if (!req.headers.authorization) return reply.status(401).send({ error: 'Unauthorized' });
  }],
};
```

### Auth middleware (per-table)

```typescript
const TableAdmin = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaAdmin),
  onRequests: [async (req, reply) => {
    if (req.user.role !== 'admin') return reply.status(403).send({ error: 'Forbidden' });
  }],
});
```

### Auto-fill audit fields

```typescript
const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),
  beforeInsert: async (db, req, record) => {
    record.created_by = req.user.id;
    record.created_at = db.expression('NOW()');
  },
  beforeUpdate: async (db, req, fields) => {
    fields.updated_by = req.user.id;
    fields.updated_at = db.expression('NOW()');
  },
});
```

### Full-text search filter

```typescript
...exportTableInfo(SchemaCustomer, { q: Type.Optional(Type.String()) }, (condition, filters) => {
  if (filters.q) {
    const or = new ConditionBuilder('OR');
    or.isILike('name', `%${filters.q}%`);
    or.isILike('email', `%${filters.q}%`);
    or.isILike('phone_number', `%${filters.q}%`);
    condition.append(or);
  }
}),
```

### Date range filter

```typescript
...exportTableInfo(SchemaOrder,
  { dateFrom: Type.Optional(Type.String()), dateTo: Type.Optional(Type.String()) },
  (condition, filters) => {
    if (filters.dateFrom && filters.dateTo) {
      condition.isBetween('order_date', filters.dateFrom, filters.dateTo);
    } else if (filters.dateFrom) {
      condition.isGreater('order_date', filters.dateFrom);
    }
  }
),
```

### Multi-tenant from JWT/header

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  getTenantId: (request) => {
    // From JWT claims
    return request.user?.organizationId ?? null;

    // Or from header (multi-tenant support)
    // const header = request.headers['x-tenant-id'] as string | undefined;
    // if (!header) return null;
    // const ids = header.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    // return ids.length === 0 ? null : ids.length === 1 ? ids[0] : ids;
  },
});
```

### Register only specific routes

You don't have to register all route plugins. Pick only what you need:

```typescript
await instance.register(searchRoutes, opts);  // read-only API
await instance.register(getRoutes, opts);
// No insert/update/delete/bulk routes = read-only
```

### Multiple prefixes for different access levels

```typescript
// Public: search + get only
await app.register(async (instance) => {
  const opts = { DbTables: publicTables };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
}, { prefix: '/public' });

// Admin: full CRUD
await app.register(async (instance) => {
  const opts = { DbTables: allTables, onRequests: [adminAuth] };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(insertRoutes, opts);
  await instance.register(updateRoutes, opts);
  await instance.register(deleteRoutes, opts);
  await instance.register(bulkUpsertRoutes, opts);
  await instance.register(bulkDeleteRoutes, opts);
}, { prefix: '/admin' });
```

---

## FAQ / Gotchas

### Schema files `default export` — do I need to register them?

No. The generated Schema files export a default Fastify plugin that calls `fastify.addSchema()`. **You do NOT need to register them manually.** The plugin works without it. The default export exists only for advanced use cases where you want `$ref` schema resolution in Swagger. If you don't need it, ignore it.

### `sqlapi.config.ts` module warning

When running the CLI, Node may show: `Module type of file:///...sqlapi.config.ts is not specified...`. This is harmless — Node detects `export default` and reparses as ESM. To suppress it, ensure your project has `"type": "module"` in `package.json`, or rename the config to `sqlapi.config.mjs`.

### TypeBox version conflicts

The CLI generates Schema files that import `Type` and `Static` from `fastify-auto-sqlapi` (not from `@sinclair/typebox` directly). This ensures the consumer uses the same TypeBox version bundled with the plugin, avoiding `[Kind]` type errors from duplicate TypeBox installations.

### Prefix behavior

The `prefix` is a standard Fastify register option. Pass it alongside the plugin options:

```typescript
await app.register(fastifyAutoSqlApi, { DbTables: dbTables, prefix: '/api' });
```

The plugin internally strips `prefix` before passing options to sub-route plugins, so it is applied only once. Without prefix, routes are at root (`/search/customer`, `/rest/customer/:id`, etc.).

### Dialect differences

| | PostgreSQL | MySQL | MariaDB |
|---|---|---|---|
| **Identifier quoting** | `"id"` | `` `id` `` | `` `id` `` |
| **Placeholders** | `$1, $2` | `?, ?` | `?, ?` |
| **RETURNING** | Yes | No | Yes (10.5+) |
| **Upsert syntax** | `ON CONFLICT ... DO UPDATE` | `ON DUPLICATE KEY UPDATE` | `ON DUPLICATE KEY UPDATE` |
| **Auto-increment PK** | Via `RETURNING` | Via `insertId` | Via `RETURNING` |
| **CLI env vars** | `POSTGRES_*` | `MYSQL_*` | `MYSQL_*` |
| **CLI introspection** | `pg` | `mysql2` | `mysql2` |

MySQL does not support `RETURNING`, so insert/upsert responses return only the PK (from record or `insertId`), not the full row.
