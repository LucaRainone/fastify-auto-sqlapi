# fastify-auto-sqlapi — Backend Configuration

How to set up schemas, tables, and configure the plugin.

> ⚠️ **Migrating from a previous version?** The join API was redesigned (no backward compat). See **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** for the full migration guide — request/response key renames, `buildRelation` signature, and validation rules. Common to backend and frontend.

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
// sqlapi.config.ts — interface: { outputDir: string; schema?: string; dialect?: DialectName; envFile?: string }
export default {
  outputDir: './src/db',       // base directory for generated files (default: './src/db')
  schema: 'public',            // DB schema to introspect (default: 'public', PostgreSQL only)
  dialect: 'postgres',         // 'postgres' | 'mysql' | 'mariadb' (default: 'postgres')
  // envFile: '../../.env',    // path to .env file, relative to cwd (default: '.env')
};
```

That's it — only these four fields exist. **No connection string, no migration path.** If the file is missing, defaults are used. The `dialect` can also be passed via CLI flag `--dialect mysql`. The `envFile` is useful in monorepo setups where the `.env` lives at the repo root.

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
    dbTables.ts              # generated — skip if already exists
```

Each `Table*.ts` file contains a `defineTable()` call with:
- Auto-detected primary keys
- Auto-detected foreign key relations (from field naming convention `*Id`)
- Commented example of `extraFiltersValidation` + `extendedCondition`
- All optional keys as commented code, ready to uncomment
- `export const TableXxx` (named export)

**No files are ever overwritten** — if they already exist, they are skipped. This makes it safe to re-run the command when new tables are added to the database. Import paths are generated without extensions (the consumer's tsconfig decides resolution).

**Edit the `Table*.ts` and `dbTables.ts` files to customize** — these files are yours to maintain.

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
  debug: true,                 // optional — log all SQL queries and params to console
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

**Note**: After registering the plugin, `app.sqlApi` is available for custom routes — see [SqlApi](#sqlapi--programmatic-high-level-api).

---

## defineTable() — Complete Reference

```typescript
import {defineTable, exportTableInfo, Type} from 'fastify-auto-sqlapi';
// Import additional utilities only when needed:
// import {buildRelation, buildUpsertRules, buildUpsertRule, ConditionBuilder} from 'fastify-auto-sqlapi';
// import type {DbTables} from 'fastify-auto-sqlapi';
```

### Minimal table

```typescript
import {defineTable, exportTableInfo} from 'fastify-auto-sqlapi';
import {SchemaCustomer as Schema} from '../schemas/SchemaCustomer';

export const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(Schema),
});
```

`exportTableInfo(Schema)` returns `{ Schema, filters, extraFilters }`. The `filters` function auto-builds WHERE conditions from any schema field present in the request.

**Important**: there is no `tableName` key in `defineTable()`. The SQL table name comes from `Schema.tableName` (set by the CLI). The route URL name is the key you use in the `dbTables` record (e.g. `{ customer: TableCustomer }` → `/search/customer`).

### Composite primary key (link/junction tables)

```typescript
import {defineTable, exportTableInfo} from 'fastify-auto-sqlapi';
import {SchemaAgentTeamLink as Schema} from '../schemas/SchemaAgentTeamLink';

export const TableAgentTeamLink = defineTable({
  primary: ['agentId', 'teamId'],
  ...exportTableInfo(Schema),
});
```

When `primary` is an array, RETURNING clauses include all PK columns, and response shapes contain all PK fields.

### All keys

```typescript
export const TableCustomer = defineTable({
  // REQUIRED
  primary: 'id',                          // PK field name (camelCase), or array for composite: ['agentId', 'teamId']
  ...exportTableInfo(Schema),             // Schema + auto-filter builder

  // OPTIONAL
  defaultOrder: 'name',                   // ORDER BY default (supports multi: 'name ASC, id DESC')
  excludeFromCreation: ['id'],            // Fields omitted from INSERT — MUST include auto-increment PKs
  distinctResults: true,                  // Use SELECT DISTINCT

  // JOINS — relations to other tables. Alias defaults to joinSchema.tableName —
  // declare it explicitly only when joining the same table twice or when you want
  // a friendlier name. Set `unique: true` for N:1 (parent) relations to enable `joinLeft`.
  allowedReadJoins: [                     // Available for search: joinMustExist / joinMultiple / joinGroup / joinLeft
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),                              // alias = 'order' (default)
    buildRelation(SchemaCustomer, 'id', SchemaAddress, 'customerId', { selection: 'id, city, zip' }), // alias = 'address'
    // N:1 example (enables joinLeft):
    // buildRelation(SchemaSession, 'userId', SchemaUser, 'id', { unique: true }),               // alias = 'user'
    // Alias multipli sulla stessa tabella (richiede alias espliciti):
    // buildRelation(SchemaSession, 'createdBy', SchemaUser, 'id', { alias: 'creator', unique: true }),
    // buildRelation(SchemaSession, 'updatedBy', SchemaUser, 'id', { alias: 'updater', unique: true }),
  ],
  allowedWriteJoins: [                    // Available for insert/update secondaries (alias is the request body key)
    buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId'),                              // alias = 'order'
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

  // SCHEMA OVERRIDES — tighten auto-generated schema validation without editing Schema files
  schemaOverrides: {
    email: Type.String({ format: 'email' }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
  },

  // VALIDATION — structured field-level validation (runs after schema, before hooks)
  validate: async (db, req, main, secondaries) => {
    // Return ValidationError[] — tuple: [field, code] or [field, code, message]
    // message defaults to code if omitted
    const errors = [];
    if (main.name === '') {
      errors.push(['name', 'required', 'cannot be empty']);
    }
    // Cross-entity: validate secondaries (e.g. date overlap in periods).
    // Note: secondaries are keyed by alias (declared in allowedWriteJoins), not by tableName.
    if (secondaries?.orders) {
      // ... check overlaps, business rules across related records
    }
    return errors;
  },
  validateBulk: async (db, req, items) => {
    // Called once with ALL items in bulk-upsert. Use for cross-item validation.
    // items: Array<{ main, secondaries? }>
    return []; // ValidationError[]
  },

  // HOOKS — side effects (runs after validation). All receive camelCase (schema field names).
  beforeInsert: async (db, req, record) => {
    // Mutate record before INSERT. Use camelCase (schema) field names — conversion is automatic.
    record.createdBy = req.user.id;
  },
  afterInsert: async (db, req, record, secondaryRecords) => {
    // Called after INSERT + secondaries. record is camelCase (input merged with generated PK).
  },
  beforeUpdate: async (db, req, fields) => {
    // Mutate fields before UPDATE. camelCase. PK is present for reference but excluded from UPDATE SET.
    fields.updatedBy = req.user.id;
  },
  afterUpdate: async (db, req, record, secondaryRecords, deletionRecords) => {
    // Called after UPDATE + secondaries + deletions, INSIDE the write transaction: throwing rolls back.
  },
  beforeDelete: async (db, req, id) => {
    // Throw to abort the single delete. For tenant-scoped tables runs only after ownership is verified.
  },
  afterDelete: async (db, req, id) => {
    // Called after a successful single delete (not on 404).
  },
  beforeBulkDelete: async (db, req, ids) => {
    // Called ONCE with all ids before a bulk delete. Throw to abort the whole batch.
  },
  afterBulkDelete: async (db, req, deletedIds) => {
    // Called ONCE with the ids ACTUALLY deleted (may be a subset of the requested ids).
  },

  // OPERATIONS — whitelist of auto-generated HTTP routes for this table.
  // Omitted = ALL operations exposed (default-open!). Does not affect programmatic sqlApi.*.
  // operations: ['search', 'get'],

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
buildRelation(mainSchema, mainField, joinSchema, joinField, options?)

// where options is fully optional:
// {
//   alias?: string;           // default = joinSchema.tableName. The key used in request/response
//                             // payloads, secondaries/deletions, and dotted-notation orderBy/conditions.
//   selection?: string;       // default '*'. Comma-separated columns: 'id, name, total'.
//   unique?: boolean;         // default false.
//                             //   false → 1:N (child→main). Allowed in joinMustExist/joinMultiple/joinGroup.
//                             //   true  → N:1 (parent→main). Allowed in joinLeft only.
// }
```

- `mainField`: field(s) in main table (string or string[])
- `joinField`: field in join table that joins to `mainField`
  - For 1:N (child→main): `joinField` is the FK on the child table → `mainField` is the PK on main
  - For N:1 (parent→main): `joinField` is the PK on the parent table → `mainField` is the FK on main

**When to declare an explicit `alias`**: only when (a) you join the same table multiple times in the same `allowedReadJoins`/`allowedWriteJoins`, or (b) you want a friendlier name in the public API surface than the SQL table name (e.g. `'orders'` instead of `'customer_order'`). Otherwise omit it — the default is `joinSchema.tableName`.

**Choosing `unique`**: if `joinField` is the PK (or part of the composite PK) of `joinSchema`, the relation is N:1 — you almost certainly want `unique: true` so the alias is usable in `joinLeft`.

**Aliasing the same table twice**: declare two `buildRelation` entries with different `alias`. Example: a `session` table referencing `user` for both `createdBy` and `updatedBy`:

```typescript
allowedReadJoins: [
  buildRelation(SchemaSession, 'createdBy', SchemaUser, 'id', { alias: 'creator', unique: true }),
  buildRelation(SchemaSession, 'updatedBy', SchemaUser, 'id', { alias: 'updater', unique: true }),
]
```

If two entries in the same `allowedReadJoins`/`allowedWriteJoins` resolve to the same alias (explicit or implicit), `defineTable` throws at startup. So you cannot accidentally have two relations sharing an alias — the error tells you to disambiguate explicitly.

The 1:N joins (`joinMustExist` / `joinMultiple` / `joinGroup`) work as: `SELECT {selection} FROM {childTable} WHERE {childFK} IN ({mainPK values})`. The N:1 join (`joinLeft`) adds `LEFT JOIN {parentTable} AS {alias} ON {alias}.{parentPK} = {main}.{mainFK}` to the main query, but only when the request actually needs it (filters/orderBy on parent fields). Otherwise a side query `SELECT FROM {parentTable} WHERE {parentPK} IN (distinct main FK values)` is used.

**`joinLeft` limitation**: `extraFilters` declared via `extendedCondition` on the parent table are not applied inside `joinLeft.filters` (only schema fields). The other join families fully support extraFilters.

### extraFilters + extendedCondition

For filters that don't map to real columns (e.g. full-text search `q`):

```typescript
import {defineTable, exportTableInfo, Type, ConditionBuilder} from 'fastify-auto-sqlapi';
import {SchemaCustomer as Schema} from '../schemas/SchemaCustomer';

const extraFiltersValidation = Type.Object({
  q: Type.String(),
});

export const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(
    Schema,
    extraFiltersValidation,
    // `filters` is auto-typed with keys from Schema.fields + extraFiltersValidation
    (condition, filters) => {
      if (filters.q) {
        const or = new ConditionBuilder('OR');
        or.isILike(Schema.col('name'), `%${filters.q}%`);
        or.isILike(Schema.col('email'), `%${filters.q}%`);
        condition.append(or);
      }
    }
  ),
});
```

`extraFilters` accepts either a `Type.Object({...})` or a plain `Record<string, TSchema>`. Extra filter fields appear in Swagger but are NOT auto-applied as `WHERE col = value` — they are handled exclusively by the `extendedCondition` callback. The `filters` parameter in the callback is fully typed with autocomplete for all schema fields + extra filter keys.

---

## Computed Fields (extension system)

`computedFields` lets you declare **virtual fields** as SQL expressions on a per-table basis. Each computed becomes usable like a regular schema field across the search API: `filters` (equality), `conditions` (operators), `orderBy` (1-parte), `computeMin/Max/Sum/Avg`, and (opt-in) in `selectComputed` for the main response. Same machinery serves JSON column extraction, derived strings, dialect-aware date/calendar bucketing — without growing the library case-by-case.

```typescript
import { defineTable, exportTableInfo, Type } from 'fastify-auto-sqlapi';
import { SchemaCustomer as Schema } from '../schemas/SchemaCustomer';

export const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(Schema),
  computedFields: {
    // JSON path extraction — dialect-aware (Postgres -> arrow, MySQL -> JSON_EXTRACT).
    statusFromMeta: ({ db, qiCol }) => ({
      expr: db.dialectName === 'postgres'
        ? `${qiCol('metadata')}->>'status'`
        : `JSON_UNQUOTE(JSON_EXTRACT(${qiCol('metadata')}, '$.status'))`,
      values: [],
      type: Type.String(),
    }),
    // Derived string column — dialect-aware concat.
    fullName: ({ db, qiCol }) => ({
      expr: db.dialectName === 'postgres'
        ? `${qiCol('firstName')} || ' ' || ${qiCol('lastName')}`
        : `CONCAT(${qiCol('firstName')}, ' ', ${qiCol('lastName')})`,
      values: [],
      type: Type.String(),
    }),
  },
});
```

Client side, the computed name behaves like any other field:

```json
{
  "filters": { "statusFromMeta": "active" },
  "conditions": [
    { "field": "fullName", "method": "isLike", "params": ["%Mario%"] }
  ],
  "orderBy": "fullName ASC",
  "selectComputed": ["fullName", "statusFromMeta"]
}
```

The values returned by `selectComputed` appear as extra fields on each `main[i]` row.

### `ComputedFieldFn` signature

```typescript
type ComputedFieldFn = (ctx: {
  db: QueryClient;                                 // dialect-aware (qi, ph, dialectName, dateTrunc, ...)
  qiCol(field: string, opts?: { qualifier?: string }): string;
}) => {
  expr: string;                                    // SQL fragment
  values: unknown[];                               // bound values (see limitations below)
  type: TSchema;                                   // REQUIRED — used by Swagger and body validation
};
```

`qiCol(field)` returns a properly-quoted column reference, optionally prefixed by an alias qualifier — the engine passes the alias automatically when the computed is invoked inside a `joinLeft` LEFT JOIN, so the same function works both inline on the main query and as a parent-side column.

### Validation & startup checks

`defineTable` throws synchronously if a computed name collides with a schema field or an `extraFilters` key on the same table. The error message tells you which name to change.

### Side queries (`joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`)

Computed fields are **per-table**: a side query operating on a join target reads `joinTableConf.computedFields`, not the main table's. So if you need `statusFromMeta` on `joinLeft.user.filters`, declare it on `TableUser`, not on `TableSession`.

For `joinLeft` specifically, the computed expr is automatically alias-prefixed by `qiCol` (the engine forwards the alias). For the other three families the side query is a separate SELECT, so plain column references suffice.

### Limitations (first round, by design)

- **Bound `values` in computed expressions** are supported only on `filters`/`conditions` (main and `joinMustExist`/`joinMultiple`/`joinGroup`). They are rejected with 400 on `selectComputed`, `computeMin/Max/Sum/Avg`, `orderBy`, and `joinLeft.filters`/`conditions` — those paths require placeholder coordination not done in the first round. Most use cases (JSON extraction, concat, dateTrunc, simple ops) need no placeholders.
- **Computed CAN be used in `joinGroup.aggregations.by`** (just pass the computed name as a string). Bound `values` are not supported in this position (rejected with 400). The existing FK-correlation rule for `orderBy <alias>.<fn>.<field>` still applies: 3-parti aggregation orderBy on a `by` that isn't the correlation FK is rejected — by definition a computed-by produces multiple groups per main row, so this is never valid.
- **Computed cannot be used as aggregation function** (`sum`/`min`/`max`/...). The values inside `aggregations.sum: ['<name>']` must be schema field names. To aggregate on a derived expression, declare the derivation as a computed and pass the computed name as the field, BUT only via `computeMin/Max/Sum/Avg` (top-level main aggregates), not the joinGroup ones.
- **No chained computed** (a computed referencing another computed). Flat-only.
- **Read-only**. Computed fields are not usable in insert/update bodies — the consumer's `expr` is for SELECT/WHERE/ORDER BY, never for writes.
- **Same expression evaluated multiple times** when used in WHERE + ORDER BY + SELECT. Cheap exprs are fine; for expensive ones, query planner CSE often helps.

---

## ConditionBuilder API

Used in `extendedCondition` callbacks, hooks, and exposed via the `conditions` field in the search API (see [AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md#conditions-advanced-filters)).

```typescript
const cb = new ConditionBuilder('AND');  // or 'OR'
cb.isEqual('column', value);
cb.isNotEqual('column', value);
cb.isGreater('column', value);
cb.isGreaterOrEqual('column', value);
cb.isLess('column', value);
cb.isLessOrEqual('column', value);
cb.isLike('column', '%value%');
cb.isILike('column', '%value%');         // case-insensitive LIKE
cb.isBetween('column', from, to);
cb.isIn('column', [val1, val2]);
cb.isNotIn('column', [val1, val2]);
cb.isNull('column', true);
cb.isNotNull('column', true);
cb.raw('column::text = $1', [value]);    // raw SQL with params (backend only, NOT exposed in API)
cb.append(otherConditionBuilder);        // nest conditions (backend only, NOT exposed in API)
```

All field-based methods (except `raw` and `append`) are available in the search API `conditions` array. New methods added to ConditionBuilder are automatically available after adding them to the whitelist.

All values are parameterized (`$1, $2, ...`), never interpolated.

---

## SqlApi — Programmatic High-Level API

Use `SqlApi` to perform CRUD operations from custom routes with the same capabilities as the auto-generated endpoints. The internal auto-generated routes also use `SqlApi`, guaranteeing a single code path.

### Using `app.sqlApi` (recommended)

After registering the plugin, `app.sqlApi` is available everywhere — no extra configuration needed:

```typescript
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  dialect: 'mysql',
  swagger: true,
  prefix: '/auto',
});

// app.sqlApi is available in any route — even outside the plugin scope
app.get('/billing/:customerId', async (request) => {
  const customerId = Number(request.params.customerId);
  return app.sqlApi.search('subscription', {
    filters: { customerId, status: 'active' },
    joinMustExist: { orders: { filters: { status: 'pending' } } },
    paginator: { page: 1, itemsPerPage: 50 },
  }, request);
});
```

`app.sqlApi` inherits all configuration from the plugin registration (dialect, DbTables, tenant, debug). No need to pass them again.

### Using `createSqlApi` (standalone — for background jobs or without the plugin)

When you need a `SqlApi` instance without registering the full plugin (e.g. background jobs, scripts, tests):

```typescript
import { createSqlApi, mysqlQueryable } from 'fastify-auto-sqlapi';

// Option 1: pass a raw pool — SqlApi creates the QueryClient internally
const sqlApi = createSqlApi(mysqlQueryable(pool), dbTables, { dialect: 'mysql' });

// Option 2: pass a pre-built QueryClient
import { createQueryClient } from 'fastify-auto-sqlapi';
const db = createQueryClient(mysqlQueryable(pool), 'mysql');
const sqlApi = createSqlApi(db, dbTables, { dialect: 'mysql' });
```

**Important**: when using `createSqlApi` standalone, always pass `dialect` in the options. It configures both the QueryClient (identifier quoting, placeholders) and the ConditionBuilder (used by filters). Without it, defaults to PostgreSQL syntax.

### Available methods

```typescript
// Search — full filter, join, pagination, aggregation support
// orderBy supports two dotted notations:
//   - 3-parti `<alias>.<fn>.<field>` for joinGroup aggregations (must be declared in the request body)
//   - 2-parti `<alias>.<field>` for joinLeft parent fields
// See AGENTS_FRONTEND.md and BREAKING_CHANGES.md for the full reference.
sqlApi.search(tableName, {
  filters?, conditions?,
  joinMustExist?, joinMultiple?, joinGroup?, joinLeft?,
  orderBy?, paginator?, computeMin?, computeMax?, computeSum?, computeAvg?,
}, request?): Promise<SearchResult>

// Get single record by PK
sqlApi.get(tableName, id, request?): Promise<GetResult>

// Insert — with optional secondaries, hooks, tenant
sqlApi.insert(tableName, { record, secondaries? }, request?): Promise<InsertResult>

// Update — with optional secondaries, deletions, hooks, tenant
sqlApi.update(tableName, { record, secondaries?, deletions? }, request?): Promise<UpdateResult>

// Delete by PK
sqlApi.delete(tableName, id, request?): Promise<DeleteResult>

// Bulk upsert
sqlApi.bulkUpsert(tableName, items, request?): Promise<BulkUpsertResult[]>

// Bulk delete
sqlApi.bulkDelete(tableName, ids, request?): Promise<BulkDeleteResult[]>
```

The `request` parameter is optional. Pass it when you need tenant resolution or hooks (which receive `req`). Without it, tenant filtering is skipped and hooks receive `undefined` as the request.

---

## QueryClient API

Available in hooks via the `db` parameter:

```typescript
db.insert(tableName, record, pkCol);                                    // INSERT, returns PK row
db.insertOrUpdate(tableName, record, conflictKeys, pkCol);              // INSERT ON CONFLICT, returns PK row
db.bulkInsert(tableName, records, pkCol, chunkSize?);                   // Multi-row INSERT, returns PK rows
db.bulkInsertOrUpdate(tableName, records, conflictKeys, pkCol, chunkSize?); // Multi-row UPSERT, returns PK rows
db.update(tableName, record, where, extraCondition?);                   // UPDATE, returns affectedRows (number)
db.delete(tableName, where);                                            // DELETE, returns affectedRows (number)
db.select({ tableName, columns?, where, values, limit?, orderBy?, joins?, distinct? }); // SELECT, returns rows
db.query(sql, values);                                                  // Raw query
db.expression(value);                                                   // Raw SQL expression (not parameterized)
```

`pkCol` can be a string (`'id'`) or an array (`['agent_id', 'team_id']`) for composite PKs. PostgreSQL/MariaDB use `RETURNING`, MySQL uses `insertId`.

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

## Key Conventions

- **camelCase in API, any case in DB**: all request/response fields are camelCase. The plugin converts via `col()` and `colMap`. For snake_case DB columns (default), conversion is automatic. For camelCase DB columns (e.g. betterauth), the CLI generates a `colMap` that preserves the original column names — no conversion needed. Manual schemas without `colMap` fall back to `toUnderscore()`.
- **All fields Optional in response**: `RETURNING *` may return any subset. Response schemas use `Type.Partial`.
- **`excludeFromCreation`**: **IMPORTANT** — auto-increment PKs (e.g. `id` serial/auto_increment) MUST be listed here, otherwise INSERT will try to send them and fail. The CLI auto-detects this and adds it by default. Also useful for `createdAt`/`updatedAt` columns managed by DB defaults or hooks.
- **`upsertMap`**: when present for a schema, INSERT becomes upsert. PostgreSQL: `ON CONFLICT (...) DO UPDATE`. MySQL/MariaDB: `ON DUPLICATE KEY UPDATE`. Applies to both main and secondary tables.
- **`schemaOverrides`**: override auto-generated schema fields with stricter TypeBox types (e.g. `{ email: Type.String({ format: 'email' }) }`). Overrides are merged into the body schema for insert, update, and bulk-upsert. The original Schema file is never modified. In updates, overridden fields are still wrapped in Optional (validates only when present). Overrides appear in Swagger.
- **Validation receives camelCase**: `validate` receives the original camelCase record (as sent by the client) and secondaries. Field names match the schema definition, with full TypeScript inference (`main.startDate`, not `main.start_date`). It returns `ValidationError[]` — tuples of `[field, code]` or `[field, code, message]`. If any errors are returned, the request is rejected with 400 before hooks or SQL execute.
- **`validateBulk` replaces `validate` in bulk**: when `validateBulk` is defined, it is called once with all items and per-item `validate` is skipped. This allows optimized batch queries instead of N individual checks. When only `validate` is defined, it runs per-item as fallback.
- **All hooks and validators receive camelCase records**: `validate` and the whole hook matrix (`beforeInsert`/`afterInsert`, `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`, `beforeBulkDelete`/`afterBulkDelete`) get records keyed by schema field names (camelCase). Mutations propagate to the SQL (plugin converts to DB column format via `colMap` after the hook). The engine internally uses `snakecaseRecord(..., schema)` after user mutations to map field names to actual DB columns.
- **Filters validation**: TypeBox schemas use `additionalProperties: false`. By default Fastify strips unknown fields silently. For 400 errors on unknown filters: `Fastify({ ajv: { customOptions: { removeAdditional: false } } })`.
- **Tenant filtering**: when `tenantScope` is set on a table and `getTenantId` is provided in plugin options, all CRUD operations are automatically scoped to the tenant. `getTenantId` returning `null`/`undefined` = admin (no filter). Returning an array = multi-tenant user (IN clause).

---

## Common Backend Patterns

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

### Custom validation (field-level, cross-entity)

```typescript
import type { ValidationError } from 'fastify-auto-sqlapi';

const TableSession = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaSession),
  allowedWriteJoins: [
    buildRelation(SchemaSession, 'id', SchemaPeriod, 'sessionId', { alias: 'periods' }),
  ],
  validate: async (db, req, main, secondaries) => {
    // ValidationError is a tuple: [field, code] or [field, code, message]
    // message defaults to code if omitted
    const errors: ValidationError[] = [];

    // Simple field validation
    if (!main.name) {
      errors.push(['name', 'required']);  // message defaults to 'required'
    }

    // Async validation (uniqueness check)
    if (main.code) {
      const existing = await db.query('SELECT 1 FROM session WHERE code = $1 AND id != $2', [main.code, main.id ?? 0]);
      if (existing.rows.length) {
        errors.push(['code', 'unique', 'already exists']);
      }
    }

    // Cross-entity: validate periods don't overlap (secondaries keyed by alias)
    const periods = secondaries?.periods;
    if (periods?.length) {
      for (let i = 0; i < periods.length; i++) {
        for (let j = i + 1; j < periods.length; j++) {
          if (periods[i].startDate < periods[j].endDate && periods[j].startDate < periods[i].endDate) {
            errors.push([`periods[${j}].startDate`, 'overlap', 'overlaps with another period']);
          }
        }
      }
    }

    return errors;
  },
});
```

`validate` runs on insert, update, and each item in bulk-upsert (when `validateBulk` is not defined). When `validateBulk` is defined, it **replaces** per-item `validate` in bulk operations — use it for optimized batch queries and cross-item validation:

```typescript
const TableSession = defineTable({
  // ...
  validateBulk: async (db, req, items) => {
    // items: Array<{ main, secondaries? }>
    // Check for duplicate codes across all items in the batch
    const codes = items.map(i => i.main.code).filter(Boolean);
    const unique = new Set(codes);
    if (unique.size !== codes.length) {
      return [['code', 'batch_unique', 'duplicate codes in batch']];
    }
    return [];
  },
});
```

### Auto-fill audit fields

```typescript
const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer),
  beforeInsert: async (db, req, record) => {
    // camelCase — schema field names. The plugin converts to the actual DB column names.
    record.createdBy = req.user.id;
    record.createdAt = db.expression('NOW()');
  },
  beforeUpdate: async (db, req, fields) => {
    fields.updatedBy = req.user.id;
    fields.updatedAt = db.expression('NOW()');
  },
});
```

### Full-text search filter

```typescript
const extraFilters = Type.Object({ q: Type.String() });

...exportTableInfo(Schema, extraFilters, (condition, filters) => {
  if (filters.q) {
    const or = new ConditionBuilder('OR');
    or.isILike(Schema.col('name'), `%${filters.q}%`);
    or.isILike(Schema.col('email'), `%${filters.q}%`);
    or.isILike(Schema.col('phoneNumber'), `%${filters.q}%`);
    condition.append(or);
  }
}),
```

### Date range filter

```typescript
const extraFilters = Type.Object({
  dateFrom: Type.String(),
  dateTo: Type.String(),
});

...exportTableInfo(Schema, extraFilters, (condition, filters) => {
  if (filters.dateFrom && filters.dateTo) {
    condition.isBetween(Schema.col('orderDate'), filters.dateFrom, filters.dateTo);
  } else if (filters.dateFrom) {
    condition.isGreater(Schema.col('orderDate'), filters.dateFrom);
  }
}),
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

