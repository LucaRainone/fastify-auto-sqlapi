# fastify-auto-sqlapi — Agent Instructions

You are configuring a Fastify server that uses `fastify-auto-sqlapi` to auto-generate CRUD APIs from PostgreSQL tables. Follow these instructions precisely.

## Overview

The plugin generates REST endpoints (search, get, insert, update, delete, bulk upsert, bulk delete) from database table definitions. No ORM — raw SQL via `pg`. The consumer defines table configurations, and the plugin handles routing, validation, and query execution.

## Setup Workflow

### 1. Install

```bash
npm install fastify-auto-sqlapi
npm install fastify @fastify/postgres
# Optional (for Swagger UI):
npm install @fastify/swagger @fastify/swagger-ui
```

### 2. Configure database connection

Create `sqlapi.config.js` (or `.ts`) in the project root:

```javascript
export default {
  outputDir: './src/schemas',  // where Schema files will be generated
  schema: 'public',            // PostgreSQL schema name
};
```

Set environment variables for DB connection (or `DATABASE_URL`):

```
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_USER=myuser
POSTGRES_PASSWORD=mypassword
POSTGRES_DB=mydb
```

### 3. Generate Schema files

```bash
npx sqlapi-generate-schema
```

This introspects the database and generates one `Schema*.ts` file per table in `outputDir`. These files are auto-generated and should not be manually edited. They contain TypeBox field definitions, `col()` for camelCase→snake_case mapping, and validation schemas.

### 4. Generate tables template

```bash
npx sqlapi-generate-tables
```

This reads the Schema files and generates a `tables.ts` template with `defineTable()` for each table. The template includes:
- Auto-detected primary keys
- Auto-detected foreign key relations (from field naming convention `*Id`)
- All optional keys as commented code, ready to uncomment
- A header comment documenting all available options

**Edit `tables.ts` to customize** — this file is yours to maintain.

### 5. Create the Fastify server

```typescript
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import {
  fastifyAutoSqlApi,
  searchRoutes,
  getRoutes,
  insertRoutes,
  updateRoutes,
  deleteRoutes,
  bulkUpsertRoutes,
  bulkDeleteRoutes,
  setupSwagger,
} from 'fastify-auto-sqlapi';
import { dbTables } from './src/schemas/tables.js';

const app = Fastify();

await app.register(fastifyPostgres, {
  connectionString: 'postgres://user:pass@localhost:5432/mydb',
});

// Option A: Single plugin (recommended)
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  swagger: true,
  prefix: '/auto',
  getTenantId: (request) => request.user?.organizationId ?? null, // optional
});

// Option B: Granular composition
await app.register(async (instance) => {
  await setupSwagger(instance, { swagger: true });

  const opts = { DbTables: dbTables };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(insertRoutes, opts);
  await instance.register(updateRoutes, opts);
  await instance.register(deleteRoutes, opts);
  await instance.register(bulkUpsertRoutes, opts);
  await instance.register(bulkDeleteRoutes, opts);
}, { prefix: '/auto' });

await app.listen({ port: 3000 });
```

This generates these endpoints for each table (e.g. `customer`):

```
POST   /auto/search/customer           — search with filters, pagination, joins
GET    /auto/rest/customer/:id         — get single record by PK
POST   /auto/rest/customer             — insert record (+ secondaries)
PUT    /auto/rest/customer             — update record (+ secondaries + deletions)
DELETE /auto/rest/customer/:id         — delete record by PK
PUT    /auto/bulk/customer             — bulk upsert (array of items)
POST   /auto/bulk/customer/delete      — bulk delete (array of PKs)
```

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
- **`upsertMap`**: when present for a schema, INSERT becomes `INSERT ON CONFLICT (...) DO UPDATE`. Applies to both main and secondary tables.
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
- **Read** (search, get, delete, bulk-delete): adds `AND organization_id = $N` to WHERE
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

Uses `IN (...)` instead of `= $N` for all WHERE clauses.

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
