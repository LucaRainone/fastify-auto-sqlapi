# fastify-auto-sqlapi — Backend Configuration

How to set up schemas, tables, and configure the plugin.

> ⚠️ **Migrating from a previous version?** The join API was redesigned (no backward compat). See **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** for the full migration guide — request/response key renames, `buildRelation` signature, and validation rules. Common to backend and frontend.

## Section map

This file is long — jump, don't scan. Every supported behavior is described here or in the
files [AGENTS.md](./AGENTS.md) links to; the compiled `dist/` is not documentation and must not
be read to answer a question about the API.

| Section | Answers |
|---|---|
| [Setup Workflow](#setup-workflow) | install, `sqlapi.config.ts`, env vars, generating Schemas and tables, registering the plugin |
| [defineTable() — Complete Reference](#definetable--complete-reference) | every table key, composite PKs, `buildRelation`, `extraFilters` + `extendedCondition` |
| [Computed Fields](#computed-fields-extension-system) | virtual SQL-expression fields usable in filters, conditions, orderBy, `selectComputed` |
| [ConditionBuilder API](#conditionbuilder-api) | building WHERE fragments by hand |
| [SqlApi](#sqlapi--programmatic-high-level-api) | **querying from your own routes, scripts and jobs** — `app.sqlApi`, `createSqlApi` |
| [QueryClient API](#queryclient-api) | the raw SQL layer under SqlApi — `db.*` inside hooks |
| [Swagger](#swagger) | exposing the generated docs |
| [Multi-Tenant Filtering](#multi-tenant-filtering) | `tenantScope` direct / indirect / `anyOf`, `getTenantId`, admin bypass |
| [Key Conventions](#key-conventions) | casing, nullability, `excludeFromCreation`, `readExclude`, `upsertMap`, `schemaOverrides`, `afterRead`, error shape, request limits |
| [Common Backend Patterns](#common-backend-patterns) | auth, custom validation, audit fields, encryption at rest, full-text search, per-prefix access levels |
| [FAQ / Gotchas](#faq--gotchas) | schema exports, prefix behavior, TypeBox conflicts, dialect differences |

**Casing in one line**: everything you write is camelCase (schema field names) except raw SQL,
`tenantScope` columns and `db.*` record keys, which name the real columns — in whatever case the
table uses. Full table in
[AGENTS.md](./AGENTS.md#naming-camelcase-in-code-real-column-names-only-when-you-address-the-db-directly).

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

This introspects the database and generates one `Schema*.ts` file per table in `outputDir/schemas/`. These files are auto-generated and should not be manually edited. They contain TypeBox field definitions, `col()` mapping each camelCase field to its real column, and validation schemas. MySQL/MariaDB requires `mysql2` as a peer dependency.

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
  maxItemsPerPage: 1000,       // optional — cap on search page size / no-paginator LIMIT (default 1000)
  maxBulkItems: 1000,          // optional — cap on bulk array length (default 1000)
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

**Note**: Granular route plugins create their own `sqlApi` decorator automatically, so they work standalone (no main plugin required). The decorator is scoped to each route plugin: if you also need `app.sqlApi` in your own routes, register the main plugin.

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

**By-single-id operations are not available for composite PKs**: `get`, `delete` and `bulkDelete` address a record by one PK value, so their routes are skipped for composite-PK tables (matching on the first column alone could hit many rows — destructively for the deletes). Explicitly listing one of them in `operations` throws at startup, and the programmatic `sqlApi.get/delete/bulkDelete` reject with 400. Use `search` (all PK fields as filters), `update` (matches every PK column), or a custom route.

### All keys

```typescript
export const TableCustomer = defineTable({
  // REQUIRED
  primary: 'id',                          // PK field name (camelCase), or array for composite: ['agentId', 'teamId']
  ...exportTableInfo(Schema),             // Schema + auto-filter builder

  // OPTIONAL
  defaultOrder: 'name',                   // ORDER BY default. camelCase fields are mapped to DB
                                          // columns (e.g. 'squadIndex' -> "squad_index"); supports
                                          // multi ('name ASC, id DESC'), computed fields, and raw
                                          // SQL fragments (unknown tokens pass through unchanged)
  excludeFromCreation: ['id'],            // Fields omitted from INSERT — MUST include auto-increment PKs
  readExclude: ['passwordHash'],          // Fields hidden from ALL reads (writes unaffected)
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
  // OR anyOf: several owner columns, the row is visible to any of them
  // tenantScope: { anyOf: ['requester_agent_id', 'target_agent_id'] },

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
  afterRead: async (db, req, rows, ctx) => {
    // The read-side hook: turn the stored representation back into the API one.
    // Called ONCE per result set (batch), with camelCase rows mutated IN PLACE.
    // Runs for get, search, joinMultiple and joinLeft — including when THIS table's rows
    // arrive through a join declared on another table (ctx.source / ctx.alias say which).
    // Not called on joinGroup (aggregates, not rows) nor when the read returned nothing.
    for (const row of rows) row.ssn = decrypt(row.ssn);
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
//   fields?: string[];        // allowlist of the target's fields reachable through this relation.
//                             // Read joins only. Must include joinField. Everything else is 400.
// }
```

- `mainField`: field(s) in main table (string or string[])
- `joinField`: field in join table that joins to `mainField`
  - For 1:N (child→main): `joinField` is the FK on the child table → `mainField` is the PK on main
  - For N:1 (parent→main): `joinField` is the PK on the parent table → `mainField` is the FK on main

**When to declare an explicit `alias`**: only when (a) you join the same table multiple times in the same `allowedReadJoins`/`allowedWriteJoins`, or (b) you want a friendlier name in the public API surface than the SQL table name (e.g. `'orders'` instead of `'customer_order'`). Otherwise omit it — the default is `joinSchema.tableName`.

**⚠️ A relation in `allowedReadJoins` is a read grant on the target table.** The join runs inside the query of the *host* table's route, so the target's `onRequests` never fire and its `operations` whitelist does not apply — a table with `operations: []` is still fully readable through any relation pointing at it. What does cross a join: `readExclude`, `tenantScope`, and the schema the relation was declared with.

To expose a table broadly but keep some of its columns narrow, give the relation a `fields` allowlist:

```typescript
allowedReadJoins: [
  buildRelation(SchemaAgent, 'userId', SchemaUser, 'id', { unique: true, fields: ['id', 'name'] }),
],
```

The relation is declared against a schema narrowed to that list, so every read surface validates against it — `selection`, `filters`, `conditions`, `orderBy`, aggregations, and the generated request/response schemas. A field outside the list is `400 Unknown field` everywhere, not just missing from the projection, and the default `'*'` selection is spelled out into the allowed columns rather than emitting a real `SELECT *`.

Rules, all enforced at declaration time:

- **Must include the join field** — it is what correlates the fetched rows with the main ones.
- **Not allowed on `allowedWriteJoins`** — the allowlist restricts reading only; write paths resolve `upsertMap` by schema identity and must write every column the caller sent. Declare two relations if the same pair is joined for reading and for writing.
- **Computed fields on the target resolve against the narrowed schema** — one that reads a field outside the list is a `400`, so a computed cannot be used to reach past the allowlist. One that stays inside keeps working.
- **Fail-closed** — a column added to the target later is not reachable through the relation until it is added to `fields`.

`fields` is not a replacement for `readExclude` (which hides a column from the owning table's own routes too). See [ADR 0010](./docs/adr/0010-joins-do-not-run-route-guards.md) and [ADR 0011](./docs/adr/0011-join-fields-allowlist.md).

**Choosing `unique`**: if `joinField` is the PK (or part of the composite PK) of `joinSchema`, the relation is N:1 — you almost certainly want `unique: true` so the alias is usable in `joinLeft`.

**Owned child tables (translations, `*_info` details): use a writeJoin, not a standalone table.** A table that only exists as a child of a parent — e.g. `product_info` with composite PK `(product_id, lang)` — should be an `allowedWriteJoins` on the parent, not its own `DbTables` entry. The engine auto-fills the FK (`product_id`); add it to `upsertMap` (conflict key = the composite PK) to upsert children passing only their own fields. Avoids redundant endpoints/validators.

```typescript
// on the parent (product) table:
allowedWriteJoins: [
  buildRelation(SchemaProduct, 'id', SchemaProductInfo, 'productId', { alias: 'translations' }),
],
upsertMap: buildUpsertRules(
  buildUpsertRule(SchemaProductInfo, ['productId', 'lang']),  // composite conflict key
),
// → PUT /rest/product { "main": {...}, "secondaries": { "translations": [{ "lang": "en", "name": "Bike" }] } }
```

Expose a composite-PK table as a standalone CRUD table only when it stands on its own (M:N link tables, natural keys) — search, insert, update and bulk upsert fully support composite PKs; the by-single-id routes (get, delete, bulkDelete) are skipped for them.

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

**Not available on `joinLeft`.** `extendedCondition` writes its own column references, which cannot be qualified with the `LEFT JOIN` alias the parent gets there, so `buildLeftJoinClauses` handles schema and computed fields only. The generated body schema does not advertise the parent's `extraFilters` under `joinLeft.<alias>.filters`, and sending one is a `400` rather than a silent no-op. Use `joinMustExist` on the same relation when you need an extra filter on the parent.

**Unknown filter keys are a `400`** (`Unknown filter field: <key>`), on the main table and on every join. A filter that does not match a schema field, an `extraFilters` key or a computed field is rejected instead of dropped: silently ignoring it would return *more* rows than the caller asked for. The check lives in the engine, so it applies to `sqlApi.search()` too, and it runs before any query — the outcome never depends on whether the main query matched rows.

---

## Computed Fields (extension system)

`computedFields` lets you declare **virtual fields** as SQL expressions on a per-table basis. Each computed becomes usable like a regular schema field across the search API: `filters` (equality), `conditions` (operators), `orderBy` (1-part), `computeMin/Max/Sum/Avg`, and (opt-in) in `selectComputed` for the main response. Same machinery serves JSON column extraction, derived strings, dialect-aware date/calendar bucketing — without growing the library case-by-case.

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
  expr: string;                                    // SQL fragment; mark each bound value with `?`
  values: unknown[];                               // one entry per `?` marker in expr
  type: TSchema;                                   // REQUIRED — used by Swagger and body validation
};
```

**Bound values use `?` markers.** The engine assigns the placeholder positions — never write `$1` or `db.ph(n)` yourself. Use `\?` for a literal question mark (PostgreSQL jsonb operator). A computed whose marker count does not match `values.length` is rejected with a descriptive error, because it would bind values the query never references:

```typescript
bonus: ({ qiCol }) => ({
  expr: `CASE WHEN ${qiCol('role')} = ? THEN ${qiCol('salary')} ELSE 0 END`,
  values: ['admin'],
  type: Type.Number(),
}),
```

`qiCol(field)` returns a properly-quoted column reference, optionally prefixed by an alias qualifier — the engine passes the alias automatically when the computed is invoked inside a `joinLeft` LEFT JOIN, so the same function works both inline on the main query and as a parent-side column.

### Validation & startup checks

`defineTable` throws synchronously if a computed name collides with a schema field or an `extraFilters` key on the same table. The error message tells you which name to change.

### Side queries (`joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`)

Computed fields are **per-table**: a side query operating on a join target reads `joinTableConf.computedFields`, not the main table's. So if you need `statusFromMeta` on `joinLeft.user.filters`, declare it on `TableUser`, not on `TableSession`.

For `joinLeft` specifically, the computed expr is automatically alias-prefixed by `qiCol` (the engine forwards the alias). For the other three families the side query is a separate SELECT, so plain column references suffice.

### Limitations (first round, by design)

- **Bound `values` in computed expressions** work anywhere the expression lands in the `WHERE` clause or in `ORDER BY`: `filters` and `conditions` (main, `joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`) and `orderBy`. The ConditionBuilder assigns the placeholder positions there, so no coordination is needed from the caller.
- They are still rejected with 400 on `selectComputed`, `computeMin/Max/Sum/Avg`, `joinGroup.aggregations.by` and `defaultOrder`. Those expressions are emitted in the `SELECT` / `GROUP BY` list, which precedes the `WHERE` values in the parameter order — there is no correct position for them there. Most use cases (JSON extraction, concat, dateTrunc, simple ops) need no bound values at all.
- **Computed CAN be used in `joinGroup.aggregations.by`** (just pass the computed name as a string). Bound `values` are not supported in this position (rejected with 400 — it is emitted in the `SELECT`/`GROUP BY` list). The existing FK-correlation rule for `orderBy <alias>.<fn>.<field>` still applies: 3-part aggregation orderBy on a `by` that isn't the correlation FK is rejected — by definition a computed-by produces multiple groups per main row, so this is never valid.
- **Computed cannot be used as aggregation function** (`sum`/`min`/`max`/...). The values inside `aggregations.sum: ['<name>']` must be schema field names. To aggregate on a derived expression, declare the derivation as a computed and pass the computed name as the field, BUT only via `computeMin/Max/Sum/Avg` (top-level main aggregates), not the joinGroup ones.
- **No chained computed** (a computed referencing another computed). Flat-only.
- **Read-only**. Computed fields are not usable in insert/update bodies — the consumer's `expr` is for SELECT/WHERE/ORDER BY, never for writes.
- **Same expression evaluated multiple times** when used in WHERE + ORDER BY + SELECT. Cheap exprs are fine; for expensive ones, query planner CSE often helps.

---

## ConditionBuilder API

Used in `extendedCondition` callbacks, hooks, and exposed via the `conditions` field in the search API (methods and params arity in [AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md)).

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

It takes and returns **camelCase schema field names**, exactly like the HTTP bodies documented in
[AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md) — `sqlApi.search('order', { filters: { customerId: 3 } })`,
never `customer_id`. Hooks, validation, computed fields and tenant scoping all run, so this is the
right entry point for application code. Drop to [`QueryClient`](#queryclient-api) only for SQL that
has no equivalent here — it is the layer underneath, with none of that behavior and with real DB
column names.

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
//   - 3-part `<alias>.<fn>.<field>` for joinGroup aggregations (must be declared in the request body)
//   - 2-part `<alias>.<field>` for joinLeft parent fields
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

The SQL layer **underneath** [`SqlApi`](#sqlapi--programmatic-high-level-api): it executes what you
give it and nothing else — no hooks, no validation, no computed fields, no tenant scoping. Reach for
it only when the operation has no `sqlApi` equivalent; anything expressed as CRUD belongs there.

It speaks the **database's own names**: real table names (`Schema.tableName`, not the schema
variable) and real column names — get them from `Schema.col('customerId')` rather than assuming a
convention, since the columns may be snake_case or already camelCase. Passing a schema field name
the mapping would have translated produces a SQL error at runtime, not a validation error.

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

Record keys are real column names (`Schema.col('field')`). Values are parameterized.

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

Every column named in a `tenantScope` — `column`, the entries of `anyOf`, `through.localField`
and `through.foreignField` — is a **real DB column name**, not a camelCase schema field: the scope
is applied to the SQL, after the request payload has been converted. Write them as the table
declares them (`organization_id` below, but `organizationId` on a camelCase table); clients keep
sending the camelCase field name either way, including when anchoring an `anyOf` write.

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
- **Upsert conflict guard** (`upsertMap` set): before the `ON CONFLICT DO UPDATE`, a probe rejects (403) any incoming conflict key that matches a row owned by another tenant — an upsert cannot overwrite or re-assign a foreign tenant's row.

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
- **Update**: pre-check via SELECT with INNER JOIN (404 if not found). If the payload also changes the through-FK (`localField`), the new value is re-validated against the tenant — moving a record into another tenant's scope is rejected (403).
- **Delete**: subquery `DELETE WHERE pk IN (SELECT ... INNER JOIN ... WHERE tenant IN (...))`

### Shared tenant (`anyOf`: several owner columns)

For a row owned by two parties and visible to either — a message (`sender_id` / `recipient_id`),
a transfer (`from_account_id` / `to_account_id`), a shift swap:

```typescript
const TableShiftSwapRequest = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaShiftSwapRequest),
  tenantScope: { anyOf: ['requester_agent_id', 'target_agent_id'] },
});
```

Behavior:
- **Read** (search, get, delete, bulk-delete): adds
  `AND (requester_agent_id IN ($N) OR target_agent_id IN ($M))`. A `NULL` column does not match
  and does not stop the other column from matching. A row with every listed column `NULL` is
  visible to nobody but an admin.
- **Joins**: the predicate crosses every join family — `joinMultiple`, `joinGroup`,
  `joinMustExist`, and `joinLeft` (in the `ON` clause, alias-qualified, so `LEFT` semantics
  survive) — exactly as a single-column scope does, including from a host table that declares no
  scope of its own.
- **Insert**: no auto-injection. The payload must **anchor** the row: at least one listed column
  present and holding a tenant id → `400` if none is present, `403` if present but all foreign.
  The other parties are stored exactly as sent. A multi-id caller is never ambiguous here,
  because nothing is being guessed.
- **Update**: strips **every** listed column from the `SET` — neither party can be re-assigned —
  and adds the OR predicate to the `WHERE`. A row outside the scope answers `404`.
- **Bulk upsert**: the anchor rule applies to every item (so an upsert must name a party even
  when it only means to update), and the listed columns are excluded from the `DO UPDATE SET`,
  so an upsert onto an existing row cannot take over the other party's slot. The conflict guard
  rejects (`403`) a conflict key matching a row visible to neither party — including a row whose
  parties are `NULL`.
- **Secondaries**: a table with an `anyOf` scope written through another table's
  `allowedWriteJoins` follows the same anchor rule. The parent's FK is auto-filled but is not an
  owner, so the child payload must still name a party.

Not combinable with `column` or `through` — `defineTable` throws at startup. An `anyOf` entry
reached through a parent FK is not supported; declare the scope on the parent instead.

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
- **400** — Multi-tenant user on insert without explicit tenant value (ambiguous), or an
  `anyOf` write naming no owner column at all
- **404** — Update with indirect tenant, record not found for this tenant; get/update/delete of
  an `anyOf`-scoped row outside the scope

---

## Key Conventions

- **camelCase in API, any case in DB**: all request/response fields are camelCase. The plugin converts via `col()` and `colMap`. For snake_case DB columns (default), conversion is automatic. For camelCase DB columns (e.g. betterauth), the CLI generates a `colMap` that preserves the original column names — no conversion needed. Manual schemas without `colMap` fall back to `toUnderscore()`.
- **All fields Optional in response**: `RETURNING *` may return any subset. Response schemas use `Type.Partial`.
- **Nullable columns use `Nullable(T)` (type-array form)**: the generator emits `Type.Optional(Nullable(T))` for nullable columns — `Nullable` (exported by the package) produces `{ type: ['integer', 'null'] }`. Do NOT replace it with `Type.Union([T, Type.Null()])`: under Fastify's default Ajv `coerceTypes` a union corrupts values through its branches (`null` → `0` with the Null branch last, `0`/`""` → `null` with it first), while the type array validates and serializes NULL correctly. A bare `Type.Optional(T)` is also wrong: NULL serializes as `0`/`""`. In `filters`, an explicit `null` on a schema field builds `WHERE col IS NULL`.
- **`excludeFromCreation`**: **IMPORTANT** — auto-increment PKs (e.g. `id` serial/auto_increment) MUST be listed here, otherwise INSERT will try to send them and fail. The CLI auto-detects this and adds it by default. Also useful for `createdAt`/`updatedAt` columns managed by DB defaults or hooks. It strips **client-supplied** values only: the payload is sanitized before `beforeInsert` runs, so a value the hook assigns to an excluded field (e.g. a server-generated TEXT id) DOES reach the INSERT. Same for the engine's FK auto-fill on secondaries — an excluded FK column does not suppress it. It is an **ergonomics tool for creation, NOT a field-level security mechanism**: it does not apply to updates — every Schema field is updatable by default, by design. Field-level update rules (`isAdmin`, roles, owner/tenant columns, state fields) are product logic: enforce them in `beforeUpdate` (silent strip) or `validate` (loud 400), or move the privileged transition to a dedicated endpoint and keep it off the auto routes via `operations`.
- **`readExclude`**: fields hidden from every read — not projected by search/get, omitted from read response schemas and from this table's default (`*`) join selection when it is a join target. Referencing one from `filters`, `conditions`, `orderBy`, `joinGroup` aggregations or an explicit join `selection` returns 400: hiding a field from output while allowing it to be filtered would leak its value by bisection. **Writes are unaffected** — insert/update/bulk still accept the field, so a column can be writable but never readable (password hash, access token). Primary keys cannot be excluded. Complementary to trimming the Schema, which removes the column from reads *and* writes. It is **per table and static**: a column hidden here is hidden from every caller, including admins. To keep a column readable on the table's own routes but not through a relation, trim the Schema the *relation* is declared with instead — see the read-grant warning under [buildRelation](#buildrelation-signature).
- **`writeExclude`**: the write-side counterpart of `readExclude` — fields removed from the insert, update and bulk-upsert bodies (main *and* secondaries) and dropped again inside the engines, which `sqlApi.*` reaches without those schemas. Reads are untouched: the field is still projected, filterable and orderable. It exists for the columns the database refuses to be told about. **A `GENERATED ALWAYS AS (<expr>)` column is already covered without any config**: the CLI records it in the Schema's `generatedFields`, and both engines reject a statement that so much as names such a column, so offering it as writable could only turn a client mistake into a `500`. The `writeExclude` key is for the rest — a column a trigger owns, one a migration is about to drop. It is **static and applies to everyone**, admins included; a rule that depends on *who* is asking is product logic and belongs in `beforeUpdate` (silent strip) or `validate` (loud 400), per [ADR 0004](./docs/adr/0004-updates-always-open.md). Not to be confused with `excludeFromCreation`, which whitelists **client input on insert only** and deliberately lets a hook assign the field afterwards — `writeExclude` runs **after** the hooks, because the column refuses the value whoever assigned it. `defineTable` rejects a field that is not in the schema, the primary key (the update body identifies the row with it) and a field that is also in `readExclude` (neither readable nor writable means: remove it from the Schema). See [ADR 0015](./docs/adr/0015-non-writable-columns.md), which narrows [ADR 0004](./docs/adr/0004-updates-always-open.md).
- **Database-computed and identity columns are detected by the CLI**: `sqlapi-generate-schema` reads `is_generated` (PostgreSQL) / `EXTRA` (MySQL, `VIRTUAL GENERATED` and `STORED GENERATED`) and prints the columns it found, per table, before writing anything — read that output. Generated columns land in the Schema's `generatedFields` and are named in a comment in the generated `Table*.ts`. Separately, `GENERATED ... AS IDENTITY` (PostgreSQL) has no `column_default` to reveal that the database fills it in: it is now flagged like MySQL's `AUTO_INCREMENT`, so the field is Optional and the CLI lists it under `excludeFromCreation` instead of emitting a mandatory primary key the database then refuses.
- **`upsertMap`**: when present for a schema, INSERT becomes upsert. PostgreSQL: `ON CONFLICT (...) DO UPDATE`. MySQL/MariaDB: `ON DUPLICATE KEY UPDATE`. Applies to both main and secondary tables.
- **`schemaOverrides`**: narrow an auto-generated field to a stricter TypeBox type (e.g. `{ email: Type.String({ format: 'email' }) }`) where `information_schema` could only report `text`. **Write bodies only** — insert, update, bulk-upsert. An override rules what the API accepts *from now on*, while the rows already stored predate it: a column narrowed to `format: 'email'` today holds whatever was accepted last year, and one made mandatory today is `NULL` on every pre-existing row. Narrowing the response would publish a promise nobody can retroactively make true, so responses and the `filters` map keep the generated type. (Nothing would break at runtime either way — Fastify does not validate responses, and `fast-json-stringify` ignores `format`/`pattern`/`minLength`/`minimum`/`enum` entirely; it acts only on `type`, by coercion.) The override is taken **verbatim**: no `Type.Optional` makes the field mandatory, no `Nullable` rejects an explicit `null`, whatever the column allows — which is how you make a column the DB had to leave nullable (a new column on a populated table) mandatory going forward. The original Schema file is never modified; the primary key is mandatory in the update body (it identifies the row); overrides appear in Swagger.
- **`afterRead`**: the read-side counterpart of `beforeInsert`/`beforeUpdate` — the place to decrypt a column, unpack a blob, rescale a stored unit. Called **once per result set** with camelCase rows mutated **in place** (a hook that calls a remote KMS gets one invocation for the page, not one per row), and awaited. Declared on the table that **owns** the column, and it follows a join: the hook runs wherever that table's rows surface, including through a `joinMultiple`/`joinLeft` declared on another table — `ctx.source` (`'get' | 'search' | 'joinMultiple' | 'joinLeft'`) and `ctx.alias` say which. Not called on `joinGroup` (aggregates, not table rows) nor on an empty result. Rows cannot be added or removed — the pagination `COUNT` has already run, so dropping rows would report a `total` that does not match; narrowing what a caller sees is `filters`/`tenantScope`/`readExclude`. On the main table it runs **after** the join side queries, which correlate on the values the database returned: a hook rewriting the column a relation joins on does not break the correlation. Two things it does not reach, by design: `filters`, `orderBy` and `compute*` run in SQL against the **stored** value (searching an encrypted column searches the ciphertext), and it transforms **values, not types** — the response is serialized against the generated schema, so a hook returning an object where the column is `text` yields `"[object Object]"`, and one returning `12.34` on an `integer` column yields `12`. Decrypting `text`→`text` or rescaling `numeric`→`numeric` is what it is for; if the stored and API types genuinely differ, that is a custom route.
- **Validation receives camelCase**: `validate` receives the original camelCase record (as sent by the client) and secondaries. Field names match the schema definition, with full TypeScript inference (`main.startDate`, not `main.start_date`). It returns `ValidationError[]` — tuples of `[field, code]` or `[field, code, message]`. If any errors are returned, the request is rejected with 400 before hooks or SQL execute.
- **`validateBulk` replaces `validate` in bulk**: when `validateBulk` is defined, it is called once with all items and per-item `validate` is skipped. This allows optimized batch queries instead of N individual checks. When only `validate` is defined, it runs per-item as fallback.
- **All hooks and validators receive camelCase records**: `validate` and the whole hook matrix (`beforeInsert`/`afterInsert`, `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`, `beforeBulkDelete`/`afterBulkDelete`, `afterRead`) get records keyed by schema field names (camelCase). Mutations propagate to the SQL (plugin converts to DB column format via `colMap` after the hook). The engine internally uses `snakecaseRecord(..., schema)` after user mutations to map field names to actual DB columns.
- **Secondaries run the child table's `beforeInsert`**: a child row written alongside a main record is a write like any other — the child's `excludeFromCreation`, its `tenantScope` and its `beforeInsert` all apply, in that order, before the engine auto-fills the FK to main (which always wins over anything the payload or the hook put there). Its `validate` and `afterInsert` deliberately do **not** run: they change when a rejection or a side effect fires, which belongs to the host's write. See [ADR 0014](./docs/adr/0014-what-follows-a-write-join.md).
- **Filters validation**: TypeBox schemas use `additionalProperties: false`. By default Fastify strips unknown fields silently. For 400 errors on unknown filters: `Fastify({ ajv: { customOptions: { removeAdditional: false } } })`.
- **Write-body whitelist**: insert/update/bulk-upsert bodies (`main` + secondaries items) are `additionalProperties: false`. Unknown properties are rejected with 400 — only columns in the generated Schema (as narrowed by `schemaOverrides`/`excludeFromCreation`) can be written, so no mass assignment of unexposed columns. Trim the Schema to keep sensitive columns unwritable.
- **Error responses**: errors the plugin raises itself are `4xx` with messages written for clients (validation, not found, tenant). Anything else — a driver constraint violation, a hook throwing without a `statusCode` — answers a fixed `{"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}`: driver messages name tables, columns and constraints, and they stay on the server. **No status code is remapped** (a unique violation is a `500`, not a `409` — that mapping is product logic). The body carries `requestId` (the `reqId` Fastify logs on every line) so the real error is one grep away in the log, where it is also written via `request.log.error` — and attached as `err.cause`, so a consumer `setErrorHandler` can map `err.cause.code === '23505'` to `409` itself. **`exposeDebugInfo: true` is the only way to get the driver detail on the wire** — set it while developing, where a client building against the API cannot always read your log: the `500` then also carries `debugInfo` (`message`, `code`, `constraint`, `detail`, `stack`), additively, so the four fields above keep their production shape. Nothing else flips it: not `debug` (server-side only, and it belongs to whoever registers the plugin), not `NODE_ENV`. Errors thrown by `onRequests` hooks run before the handler and are unaffected.
- **Request limits**: `maxItemsPerPage` (default 1000) caps the search page size and is applied as the `LIMIT` even when no paginator is sent (so an empty-body search can't dump a whole table); over-limit `itemsPerPage` → 400. `maxBulkItems` (default 1000) caps the bulk array length via schema `maxItems` → 400. Programmatic `sqlApi.*` calls are uncapped.
- **Tenant filtering**: when `tenantScope` is set on a table and `getTenantId` is provided in plugin options, all CRUD operations are automatically scoped to the tenant. `getTenantId` returning `null`/`undefined` = admin (no filter). Returning an array = multi-tenant user (IN clause). The tenant belongs to the *request*, not to the table it addresses: a scoped table is filtered even when reached as a join target or written as a secondary of an unscoped host, so `getTenantId` must tolerate a request with no authenticated user (`req.user?.x ?? null`).

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

### PostgreSQL driver type parsers (numeric/int8 as strings, timestamp shifts)

The `pg` driver — not the plugin — returns `numeric`/`int8` as **strings** (precision
safety), parses `date` into a JS `Date` at local midnight, and interprets
`timestamp without time zone` in the server's local timezone. The plugin deliberately does
not touch `pg.types` (global process state — see the design principles). If your API should
return numbers and stable date strings, configure the parsers once at startup, before
creating the pool:

```typescript
import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));
// Keep dates/timestamps as verbatim strings (no local-timezone Date conversion).
// Recommended when the DB stores UTC in `timestamp without time zone` (several ERPs do).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => v);
```

Note: HTTP responses already coerce a numeric string like `"42"` to a number when the
schema says integer — the parsers matter for programmatic `sqlApi.*` results, arithmetic in
hooks, and timestamp correctness.

### Translated jsonb fields (multi-language columns)

Some applications (several ERPs among them) store translatable columns as jsonb:
`{"en_US": "Bike", "it_IT": "Bici"}`. Expose the translation as a computed field — usable
in `filters`, `conditions`, `orderBy` and (opt-in) projected via `selectComputed`:

```typescript
const LANG = process.env.APP_LANG || 'en_US';

const TableProductTemplate = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaProductTemplate),
  computedFields: {
    displayName: ({ qiCol }) => ({
      expr: `${qiCol('name')}->>'${LANG}'`,
      type: Type.String(),
    }),
  },
});
// → POST /search/product_template { "filters": { "displayName": "Bike" } }
//   or body { "selectComputed": ["displayName"] } to project it in the response
```

### Protect sensitive fields on update (isAdmin, roles, ownership)

Every Schema field is updatable by default — the plugin does not impose field-level rules
(see `excludeFromCreation` in Key Conventions). Encode yours in the hooks:

```typescript
const TableUser = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaUser),
  // Silent strip: non-admins simply cannot touch the flag
  beforeUpdate: async (db, req, fields) => {
    if (!req.user.isAdmin) delete fields.isAdmin;
  },
  // Or loud 400 via validate:
  // validate: async (db, req, main) => {
  //   if (main.isAdmin !== undefined && !req.user.isAdmin)
  //     return [['isAdmin', 'forbidden']];
  //   return [];
  // },
});
```

For privileged transitions (promote to admin, move across tenants) prefer a dedicated
endpoint with its own auth/audit, and keep the operation off the auto routes via `operations`.

### Encrypt a column at rest (storage representation ≠ API representation)

Three declarations on the table that owns the column — in on the write hooks, out on the read
hook — and nothing at the call sites:

```typescript
const TablePatient = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaPatient),

  beforeInsert: async (db, req, record) => {
    if (record.ssn != null) record.ssn = encrypt(record.ssn);
  },
  beforeUpdate: async (db, req, fields) => {
    if (fields.ssn != null) fields.ssn = encrypt(fields.ssn);
  },
  afterRead: async (db, req, rows) => {
    for (const row of rows) {
      if (row.ssn != null) row.ssn = decrypt(row.ssn);
    }
  },
});
```

`afterRead` covers `GET /rest/patient/:id`, `POST /search/patient`, and every `joinMultiple` /
`joinLeft` that reaches `patient` from another table's search — the hook belongs to the table
that owns the column, so a relation declared elsewhere needs no extra wiring. The same holds on
the way in: a patient written as a **secondary** of another table's insert runs this
`beforeInsert` too.

What the plugin does *not* do for you, because it cannot know your cipher:

- **searching**: `filters: { ssn: '123-45' }` compares the plaintext against the ciphertext in
  SQL and matches nothing. With a deterministic cipher, encrypt the value yourself in
  `extendedCondition`; with a randomized one, that column is not searchable at all. `orderBy`
  and `computeMin/Max` sort and aggregate the ciphertext.
- **typing**: the hook transforms values, not types. The response is serialized against the
  generated schema, so returning an object where the column is `text` yields
  `"[object Object]"`. `text`→`text` and `numeric`→`numeric` transforms are the supported shape.
- **aggregates**: `joinGroup` and `compute*` return values the hook never sees.

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

### LLM / agent surface (read-only + manifest)

Give a chat agent direct data access with the plugin as enforcement layer (tenant scoping,
`readExclude`, caps still apply to whatever the model invents). Read-only surface + the
manifest endpoint, agent-specific auth:

```typescript
import { searchRoutes, getRoutes, agentManifestRoutes } from 'fastify-auto-sqlapi';

await app.register(async (instance) => {
  const opts = { DbTables: dbTables, onRequests: [agentAuth] };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(agentManifestRoutes, opts);   // GET /agent/manifest(.md)
}, { prefix: '/agent' });
```

System prompt = `AGENTS_FRONTEND.md` (request grammar, ships in the package) + the output of
`GET /agent/manifest.md` (this deployment's tables/fields/aliases). On the main plugin the
manifest is enabled with the `agentManifest: true` option. Validation strategy: either a
loose generic tool (`table` enum from the manifest, free body) with the structured 400
`fields[]` as the retry signal, or strict provider-side tools via
`agentToolSchemas(dbTables, table)` — the exact JSON Schemas the routes validate with.

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

