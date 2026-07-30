# fastify-auto-sqlapi

**Your database already knows its tables, columns and relations. This plugin turns that knowledge into a complete REST API inside your [Fastify](https://fastify.dev/) app.**

Two CLI commands introspect PostgreSQL / MySQL / MariaDB and generate typed schemas; one `register()` call turns each table *you choose to expose* into seven endpoints: search with filters, advanced conditions, relation joins and aggregations; validated writes with nested child records; bulk upsert/delete; multi-tenant isolation; Swagger docs. Related tables don't need endpoints of their own — reads reach them through joins, writes through nested children — so a whole subgraph can live behind a single exposed table. What's left to write is what makes your product yours — auth, business rules, custom logic — as plain TypeScript hooks next to your other routes.

One request, to show the point — *"active customers with over 500 total in completed orders, with their order stats, biggest spenders first"*:

```jsonc
// POST /api/search/customer?orderBy=orders.sum.total DESC&page=1&itemsPerPage=20
{
  "filters": { "status": "active" },
  "joinGroup": {
    "orders": {
      "filters": { "status": "completed" },
      "aggregations": { "sum": ["total"], "count": ["id"] }
    }
  },
  "conditions": [{ "field": "orders.sum.total", "method": "isGreater", "params": [500] }]
}
```

Under the hood this is a fixed, request-shaped number of set-based queries — the main select plus one per requested join alias (EXISTS clauses and correlated subqueries ride inside them), **never one per returned row**. There are no lazy relations to accidentally loop over: the N+1 problem is structurally absent, not something you remember to avoid.

Writes read the same way — *"sync these clients and their tags: update the ones that exist, insert the missing ones, don't duplicate a tag"*:

```jsonc
// PUT /api/bulk/customer — all mains in one SQL; child FKs auto-filled from each parent
[
  { "main": { "email": "mario@acme.it", "name": "Mario" },
    "secondaries": { "tags": [{ "tag": "vip" }, { "tag": "newsletter" }] } },
  { "main": { "email": "luigi@acme.it", "name": "Luigi" } }
]
// → 200 [{ "main": { "id": 1 }, "secondaries": { "tags": [{ "id": 10 }, { "id": 11 }] } },
//        { "main": { "id": 2 } }]
```

Conflict keys are declared server-side (`upsertMap`: here customer on `email`, tag on `(customerId, tag)`), so re-sending the same payload updates rows instead of duplicating them — client-side sync without hand-written diffing.

And multi-tenancy is one plugin option (`getTenantId: (req) => req.user.organizationId`), enforced on reads *and* writes with zero code in handlers. Rows of other tenants are simply invisible (`404`); here a caller in org B tries to re-point one of their own orders to a customer belonging to org A:

```jsonc
// PUT /api/rest/order — order 7 is mine, customer 41 belongs to another tenant
{ "main": { "id": 7, "customerId": 41 } }
// → 403 Forbidden — cross-tenant references are rejected server-side
```

No endpoint written by hand, no resolvers, no query language on the server — and these requests are schema-validated, Swagger-documented, size-capped and tenant-isolated like every other one.

## Not an ORM, not GraphQL — a third thing

- **Not an ORM.** An ORM is a library *your* code uses to talk to the database — you still hand-write every endpoint on top of it. This plugin generates the endpoints themselves. And there is no ORM underneath either: no models, no migrations, no second schema to keep in sync. The database is the single source of truth (the CLI reads it from `information_schema`), and every request runs as plain parameterized SQL you can read with `debug: true`.
- **Not GraphQL.** GraphQL buys client-driven flexibility with a heavy toolchain: a schema layer, hand-written resolvers (and their N+1 traps), mutations written one by one, client libraries, and query-cost analysis to stop hostile requests. This plugin covers what most projects actually reach for GraphQL for — filter, paginate, join related data, aggregate, in one round trip — with a fixed JSON grammar over plain REST: curl-able, Swagger-documented, bounded by design (join depth is fixed, page and bulk sizes are capped). The write side — nested children, upserts, bulk — is generated too, which GraphQL never gives you for free. What you give up: arbitrarily deep nesting, per-field selection on the main table, subscriptions. If you need those, you need GraphQL; most CRUD backends don't.
- **Not a hosted black box.** PostgREST / Hasura / Supabase give you an instant API as a separate service, configured from the outside. This is a plugin inside your own app: hooks, validation and auth are TypeScript functions in your codebase, and you can always drop down to `app.sqlApi.*` or raw SQL in a custom route — same engine, no lock-in.

## Features

- **Zero boilerplate** — 7 endpoints per exposed table; related tables can stay behind joins and nested writes instead of getting endpoints of their own
- **No ORM** — raw SQL via `pg` + parameterized queries; set-based joins, so no N+1 by construction
- **Agent-ready** — `AGENTS.md` and the ADRs ship *inside* the npm package, so a coding agent can configure the library without reading the source or guessing intent
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

> ⚠️ **Upgrading?** See **[CHANGELOG.md](./CHANGELOG.md)** for what changed in each release, and
> **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** for migration guides. If you use `computedFields`
> with bound values, read the 0.1.6 entry — earlier versions could return wrong rows.


## Quick Start

### 1. Install

```bash
npm install fastify-auto-sqlapi fastify @fastify/postgres
# MySQL/MariaDB: npm install fastify-auto-sqlapi fastify mysql2
```

### 2. Create the config file

Create `sqlapi.config.ts` (or `.mjs`/`.js`) in your project root. This is used only by the
CLI generators, not at runtime.

```typescript
export default {
  outputDir: './src/db',       // base dir for generated files (default: './src/db')
  schema: 'public',            // PostgreSQL schema to introspect (default: 'public')
  // dialect: 'mysql',         // 'postgres' (default) | 'mysql' | 'mariadb'
  // envFile: '.env.local',    // env file to load (default: '.env')
  // excludeTables: ['knex_*'], // tables to skip in schema generation ('*' = wildcard)
};
```

The DB connection is read from environment variables (a `.env` file in the project root is
loaded automatically, without overriding variables already set):

```bash
# Either a full connection string:
DATABASE_URL=postgres://user:pass@localhost:5432/mydb   # or mysql://...

# Or individual vars (PostgreSQL):
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_USER=myuser
POSTGRES_PASSWORD=mypassword
POSTGRES_DB=mydb

# Or individual vars (MySQL/MariaDB):
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=myuser
MYSQL_PASSWORD=mypassword
MYSQL_DB=mydb
```

### 3. Generate schemas from your database

```bash
npx sqlapi-generate-schema                  # all tables
npx sqlapi-generate-schema --tables customer,order   # only some
npx sqlapi-generate-schema --dialect mysql  # override the config dialect
```

This introspects your tables and generates one TypeBox schema file per table in
`<outputDir>/schemas/` (e.g. `SchemaCustomer.ts`, `SchemaOrder.ts`). These files are
auto-generated — don't edit them; re-run the command after a DB change.

To keep some tables out of schema generation (migration bookkeeping, PostGIS internals, …)
list them in `excludeTables` in the config — exact table names or `*` globs (e.g.
`knex_*`). Excluded tables are invisible to the generator: their schemas are not created,
and any previously generated schema file is removed as an orphan on the next full run,
like that of a dropped table.

### 4. Generate the tables template

```bash
npx sqlapi-generate-tables --all            # or: npx sqlapi-generate-tables customer order
```

This creates in `<outputDir>/tables/` one `Table*.ts` file per table — a `defineTable()`
call with auto-detected primary keys, foreign key relations, and all available options as
commented code — plus a `dbTables.ts` index. **These files are yours to customize**: the
generator never overwrites an existing file, so re-running it only adds files for new tables.

### 5. Register the plugin

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

## Working with coding agents

The library is documented for two readers. Humans get this README; agents get task-oriented
files that ship in the published package, so they are already on disk after `npm install`:

| File                                   | Contents                                                          |
| -------------------------------------- | ----------------------------------------------------------------- |
| `AGENTS.md`                            | Entry point: what the library does, which file to read for what   |
| `AGENTS_BACKEND.md`                    | `defineTable` reference, hooks, tenancy, computed fields, CLI      |
| `AGENTS_FRONTEND.md`                   | Request/response shapes for every endpoint                        |
| `docs/adr/`                            | Why the non-obvious behaviours are what they are                  |

Point your agent at them once:

> Read `node_modules/fastify-auto-sqlapi/AGENTS.md` before touching anything under `src/db/`.

Three design choices make the generated code predictable enough for an agent to write it
unsupervised:

- **Configuration is declarative and local.** A table is one `defineTable()` call — nothing to
  wire across files, so a diff is reviewable at a glance.
- **One naming convention.** camelCase in requests, responses, hooks and validators; the
  mapping to DB columns is automatic. There is no second convention to remember, and no
  layer where the agent has to guess which one applies.
- **Errors are machine-readable.** A 400 carries `fields: [{ path, code, message }]`, so a
  failing request tells the agent exactly what to fix instead of requiring a guess.

The ADRs matter more than they look: they answer the "why is it like this?" questions
(open-by-default, non-transactional bulk, always-updatable fields) that an agent would
otherwise resolve by inventing a workaround — or by proposing to change intentional behaviour.

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
  defaultOrder: 'name',                     // default ORDER BY (camelCase fields map to DB columns)
  excludeFromCreation: ['id'],              // client-sent values ignored on INSERT (auto-increment,
                                            // DB defaults); beforeInsert can still set them
  readExclude: ['passwordHash'],            // hide from all reads (writes unaffected)
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
  maxItemsPerPage: 1000,        // Optional — cap on search page size (default: 1000)
  maxBulkItems: 1000,           // Optional — cap on bulk array length (default: 1000)
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
| `maxItemsPerPage` | `number` | No | Max search page size, and the row `LIMIT` applied when no paginator is sent (default: `1000`) |
| `maxBulkItems` | `number` | No | Max number of items accepted by the bulk endpoints (default: `1000`) |
| `debug` | `boolean` | No | Log all SQL queries to console |

The plugin picks up the connection from the Fastify instance: `fastify.pg` for PostgreSQL
(what `@fastify/postgres` decorates) or `fastify.mysql` for MySQL/MariaDB. For MySQL,
decorate a `mysql2/promise` pool (e.g. via `@fastify/mysql` with `promise: true`, or manually)
and pass `dialect: 'mysql'` or `'mariadb'`:

```typescript
import mysql from 'mysql2/promise';

const pool = mysql.createPool({ host: '127.0.0.1', user: 'myuser', password: '...', database: 'mydb' });
app.decorate('mysql', pool);
app.addHook('onClose', async () => { await pool.end(); });

await app.register(fastifyAutoSqlApi, { DbTables: dbTables, dialect: 'mysql' });
```

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

### Request limits

Two hard caps bound how much work a single request can trigger (defense against accidental or
malicious resource exhaustion — relevant precisely because the API is open by default):

- **Search result size** — `itemsPerPage` above `maxItemsPerPage` (default `1000`) is rejected
  with `400`. When a search omits pagination entirely, the same value is applied as a `LIMIT`, so
  an empty-body `POST /search/:table` can never dump an entire table.
- **Bulk array size** — the `PUT /bulk/:table` and `POST /bulk/:table/delete` bodies reject arrays
  longer than `maxBulkItems` (default `1000`) at schema validation.

Both are configurable in the plugin options. The programmatic `fastify.sqlApi.*` methods are not
capped — they run your own trusted code.

### Write whitelist

Insert/update/bulk-upsert bodies reject **unknown properties** (`additionalProperties: false`):
only columns present in the generated Schema (as narrowed by `schemaOverrides` /
`excludeFromCreation`) can be written. An unexpected field is a `400`, never a silently-written
column — the Schema is the write whitelist. Trim the generated Schema (or use `excludeFromCreation`)
to keep sensitive columns out of it.

### Field-level update rules are product logic — use the hooks

`excludeFromCreation` is an **ergonomics tool for creation**, not a security mechanism: it
exists so auto-generated values (serial PKs, DB-default timestamps) don't have to be sent —
or validated — on insert. It deliberately does **not** apply to updates: every field in the
Schema is updatable by default, because whether a field may change is a product decision the
plugin cannot make for you (a super admin may legitimately fix an `updatedAt`; in one product
users may move themselves across tenants, in another nobody may).

So watch out for **sensitive flags and ownership fields** — `isAdmin`, `role`, tenant/owner
columns, state fields: if they are in the Schema, the auto-generated update route will accept
them. Encode your rules with the tools made for it:

```typescript
// Silent strip: non-admins simply cannot touch the flag
beforeUpdate: async (db, req, fields) => {
  if (!req.user.isAdmin) delete fields.isAdmin;
},

// Loud 400: touching the flag without permission is an error
validate: async (db, req, main) => {
  if (main.isAdmin !== undefined && !req.user.isAdmin)
    return [['isAdmin', 'forbidden']];
  return [];
},
```

For privileged state transitions (promoting an admin, moving a record across tenants) consider
a dedicated endpoint with its own auth and audit instead of the auto-generated CRUD route —
`operations` lets you keep the sensitive operation off the auto routes entirely.

Note on tenants: when `tenantScope` is active, tenant-scoped callers can never move a record to
another tenant (the tenant column is enforced server-side); admin callers (`getTenantId` →
`null`) are unrestricted. That is the isolation contract of the opt-in tenancy feature, not a
field-level rule.

### Read visibility

`readExclude` hides columns from every read while leaving writes untouched — the case for a
password hash or an access token: writable, never readable.

```typescript
readExclude: ['accessToken'],
```

Excluded fields are not selected by search/get, are omitted from read response schemas and from
the table's default join selection, and cannot be referenced from `filters`, `conditions`,
`orderBy`, aggregations or an explicit join `selection` (`400`). That last part is the point:
letting a hidden field be filtered would leak its value by bisection. Primary keys cannot be
excluded.

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

> `itemsPerPage` is capped at `maxItemsPerPage` (default `1000`); a larger value returns `400`. A search with no `page`/`itemsPerPage` returns at most that many rows (no full-table dumps). See [Request limits](#request-limits).

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

> **Composite primary keys:** `GET /rest/:id`, `DELETE /rest/:id` and `POST /bulk/:table/delete`
> address a record by a single PK value, so they are **not registered** for tables whose
> primary key spans multiple columns (a match on the first column alone could hit many rows —
> for the deletes, destructively). Explicitly listing one of these operations in `operations`
> for such a table throws at startup. Use `search` with all PK fields in the filters, `update`
> (which matches every PK column), or a custom route.

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
> Expose a composite-PK table as a standalone CRUD table only when it stands on its own (M:N link tables, natural keys) — search, insert, update and bulk upsert fully support composite PKs; the by-single-id routes (get, delete, bulkDelete) are skipped for them (see the note under GET).

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

**Response (200):** `{ main: { <pk>: ... } }` (PK-only, like all write responses), or `404` if
the record does not exist.

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

### Isolation guarantees on writes

Tenant isolation is enforced on write paths, not just reads:

- **Upsert conflicts are ownership-checked.** On a tenant-scoped table with an `upsertMap`, an
  upsert (`POST /rest/:table` or `PUT /bulk/:table`) whose conflict key matches a row owned by
  another tenant is rejected with `403` — it cannot overwrite or re-assign that row.
- **The tenant link cannot be changed to another tenant.** For direct scopes the tenant column is
  stripped from update payloads. For indirect scopes, changing the through-FK (`localField`) is
  allowed only to a value the caller owns; otherwise the update returns `403`.

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

## LLM / agent clients

The plugin is a natural enforcement layer for an agent that operates on your data through
chat: whatever requests the LLM invents, they pass through the same tenant scoping,
`readExclude`, `operations` whitelist, validation and request caps as any HTTP client —
direct-DB firepower, backoffice constraints. Three pieces make this practical:

**1. The grammar** — [`AGENTS_FRONTEND.md`](./AGENTS_FRONTEND.md) (ships in the npm package)
is a compact, LLM-oriented reference of how to call the API: search with all four join
families, ordering, pagination, writes, error shapes. Put it in the system prompt.

**2. The vocabulary** — enable the manifest endpoint to describe *this deployment's* tables:

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  agentManifest: true,   // GET {prefix}/agent/manifest (JSON) + /agent/manifest.md
});
```

`GET /agent/manifest.md` returns a compact markdown block per table — fields with
type/required/nullable, enabled operations, join aliases (with direction), computed fields,
extra filters — always in sync with the running config, behind the same `onRequests` auth.
Fetch it at session start: grammar + vocabulary is everything the model needs. The same data
is available programmatically via `buildAgentManifest(dbTables)` /
`renderAgentManifestMd(manifest)`.

**3. The guardrails** — writes are often too dangerous to hand to a model. Register a
read-only surface with granular composition and give the agent only that:

```typescript
import { searchRoutes, getRoutes, agentManifestRoutes } from 'fastify-auto-sqlapi';

await app.register(async (instance) => {
  const opts = { DbTables: dbTables, onRequests: [agentAuth] };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(agentManifestRoutes, opts);
}, { prefix: '/agent' });   // reads only: no insert/update/delete routes exist here
```

**Validation strategy** — two options, per table or per deployment:

- *Loose tool + retry loop* (recommended default): expose a generic tool
  (`table` as enum from the manifest, `body` as free object) and let the plugin validate.
  A failed request returns a structured 400 with `fields: [{path, code, message}]` — feed
  it back to the model and it self-corrects in one round trip. Cheap prompts, no schema
  duplication.
- *Strict tools*: `agentToolSchemas(dbTables, 'customer')` returns the exact JSON Schemas
  the routes validate with (body + querystring for search, bodies for writes, only for the
  operations enabled on that table) — plug them into provider-side tool definitions when
  you want invalid calls rejected before they leave the model. Costs prompt size; best for
  a few hot tables.

## Design Decisions

Deliberate, non-obvious choices — open-by-default, non-transactional bulk operations,
always-updatable fields, raw DB errors, insert-pipeline ordering — are recorded as
[Architecture Decision Records in `docs/adr/`](./docs/adr/README.md), each with its
rationale and the alternatives that were rejected. Read them before filing an issue that
proposes changing one of these behaviors.

## Conventions

- **camelCase everywhere in the API** — requests, responses, `validate`, and all hooks (`beforeInsert`/`afterInsert`, `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`, `beforeBulkDelete`/`afterBulkDelete`) use schema field names
- **Conversion to DB column format is automatic** via `colMap` — supports both snake_case and camelCase DB columns (e.g. betterauth-style)
- **Aliases identify joins** — declared in `buildRelation({ alias })`, used as keys in request/response/`secondaries`/dotted notation
- **`joinMustExist` / `joinMultiple` / `joinGroup`** are 1:N (child→main) and use side queries / EXISTS / correlated subqueries — no row duplication
- **`joinLeft`** is N:1 (parent→main) and adds a real `LEFT JOIN` on demand (only when filtering/ordering by parent)
- **All response fields are Optional** — response schemas use `Type.Partial` since `RETURNING *` may return any subset
- **Nullable columns use `Nullable(T)`** — the generator emits the JSON-Schema type-array form (`type: ['integer', 'null']`) via the exported `Nullable()` helper. This is deliberate: a bare `Type.Optional(T)` serializes NULL as `0`/`""`, and a `Type.Union([T, Type.Null()])` gets corrupted by Ajv's default type coercion (`null` ↔ `0`/`""` through the branches). In `filters`, an explicit `null` filters by `IS NULL`
- **The `pg` driver returns `numeric`/`int8` as strings** and parses timestamps into local-timezone `Date`s — driver defaults the plugin deliberately does not override (global state). See "PostgreSQL driver type parsers" in AGENTS_BACKEND.md for the recommended one-time setup

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
  Nullable,               // type-array nullable schema (see Conventions)

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
- Fastify >= 5 (peer dependency)
- One of:
  - **PostgreSQL** + `pg` + `@fastify/postgres`
  - **MySQL** / **MariaDB** + `mysql2`
- Optional: `@fastify/swagger` + `@fastify/swagger-ui` for Swagger UI

## License

MIT
