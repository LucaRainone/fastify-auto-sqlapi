# fastify-auto-sqlapi — backend reference (LLM)

Setting up the plugin and configuring tables. Client request grammar: AGENTS_FRONTEND.md. Migrating from `joinFilters`/`joins`/`joinGroups`: BREAKING_CHANGES.md.

## Rules

- Everything is a camelCase **schema field name** (request/response bodies, `defineTable` keys, hooks, `validate`, `sqlApi.*`, `buildRelation`). **Real DB column names** only where you talk to the database yourself: `db.*` (QueryClient), `tenantScope`, and any SQL string you write. Get them with `Schema.col('field')` / `qiCol('field')`, never type them: columns may be snake_case or camelCase, the generated Schema knows which.
- `sqlApi` = high-level (camelCase, validation, hooks, tenant, joins, computed). `db` = the SQL layer under it (real names, none of that). Not interchangeable.
- Do not read `node_modules/fastify-auto-sqlapi/dist/`: internal, unstable, not documentation. If this file does not answer, say so.
- Behaviors that look like bugs but are decisions (docs/adr/): default-open `operations`, non-transactional bulk, every field updatable, raw 500 on DB errors, joins not running the target's route guards, no conditional/mass update route. Do not "fix" them.

## CLI: generate Schemas and tables

```ts
// sqlapi.config.ts — CLI only, never read at runtime. These six keys are all that exist.
export default {
  outputDir: './src/db', // default './src/db'
  schema: 'public', // PostgreSQL only
  dialect: 'postgres', // 'postgres' | 'mysql' | 'mariadb'; or --dialect flag
  envFile: '.env', // relative to cwd; useful in monorepos
  excludeTables: ['knex_*'], // DB table names or * globs: no schema generated, old one removed
  excludeColumns: ['*.password_hash', 'user.internal_*'], // "<table>.<column>" DB names, * globs. The column does not exist for the API at all (no read, write, filter, manifest). Cannot exclude a PK; a pattern leaving a table with no columns fails the run.
};
```

Connection comes from env (a `.env` in cwd is loaded, set vars win): `DATABASE_URL`, or `POSTGRES_HOST|PORT|USER|PASSWORD|DB` / `MYSQL_HOST|PORT|USER|PASSWORD|DB`.

```bash
npx sqlapi-generate-schema [--dialect mysql] # src/db/schemas/Schema*.ts — generated, NEVER edit (overwritten)
npx sqlapi-generate-tables customer order # src/db/tables/Table*.ts + dbTables.ts — yours to edit
npx sqlapi-generate-tables --all # existing files are skipped, never overwritten
```

- The generated table files detect PKs, `*Id` foreign keys as relations, and put every other key in as commented code.
- The schema CLI prints what it could not decide for you: read that output. It covers database-generated columns (`GENERATED ALWAYS AS`, put in the Schema's `generatedFields` and never writable) and identity/auto-increment PKs (made optional and listed in `insertExclude`). It also prints each view's inferred PK (see Views).
- Schema files import `Type` from `fastify-auto-sqlapi`; do the same for `schemaOverrides`, computed fields and extra filters. Any `typebox` 1.x schema works too, but one built with the legacy `@sinclair/typebox` 0.x loses its markers here: its `Type.Optional` fields silently become required. Their default export (`addSchema`) is optional, only for Swagger `$ref`.

## Server setup

```ts
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';
import { dbTables } from './src/db/tables/dbTables.js';

const app = Fastify();
await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL }); // → fastify.pg
await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables, // required. Record key = route name: { customer } → /search/customer
  dialect: 'postgres', // 'postgres' (default) | 'mysql' | 'mariadb'
  prefix: '/auto', // standard Fastify prefix, applied once. None → /search/customer
  swagger: true, // or { title, description, version, routePrefix }. Needs @fastify/swagger + @fastify/swagger-ui, else warns and continues
  onRequests: [auth], // global hooks on every route
  getTenantId: (req) => req.user?.organizationId ?? null, // see Tenant scope
  maxItemsPerPage: 1000, // search page cap AND the LIMIT when no paginator is sent → 400 above it
  maxBulkItems: 1000, // bulk array cap → 400 above it
  agentManifest: true, // GET {prefix}/agent/manifest(.md), behind the same onRequests
  debug: true, // log SQL server-side; never changes a response
  exposeDebugInfo: false, // DEV ONLY: add driver error (message, code, constraint, detail, stack) as `debugInfo` on 500s
});
// app.sqlApi is now decorated, usable from any route.

// MySQL/MariaDB: decorate a mysql2/promise pool as `mysql` instead of registering @fastify/postgres
const pool = mysql.createPool({ host, user, password, database });
app.decorate('mysql', pool);
app.addHook('onClose', () => pool.end());
await app.register(fastifyAutoSqlApi, { DbTables: dbTables, dialect: 'mysql' });

// Register only specific routes / different access levels per prefix. Each route plugin works standalone and decorates its own scoped sqlApi; register the main plugin if your own routes need app.sqlApi.
import { searchRoutes, getRoutes, insertRoutes, updateRoutes, deleteRoutes, bulkUpsertRoutes, bulkDeleteRoutes, agentManifestRoutes, setupSwagger } from 'fastify-auto-sqlapi';
await app.register(async (instance) => {
  await setupSwagger(instance, { swagger: true });
  const opts = { DbTables: publicTables, dialect: 'postgres' };
  await instance.register(searchRoutes, opts); // read-only: no insert/update/delete/bulk
  await instance.register(getRoutes, opts);
}, { prefix: '/public' });
```

`pg` returns `numeric`/`int8` as strings and shifts `date`/`timestamp` to local time. The plugin leaves `pg.types` alone (global state). If you want numbers and verbatim dates, set this at startup:

```ts
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => v);
```

HTTP responses coerce `"42"` to a number anyway. The parsers matter for `sqlApi.*` results and for hook arithmetic.

## defineTable

Every key except `primary` and `exportTableInfo` is optional. There is no `tableName` key: the SQL table is `Schema.tableName`, and the route/manifest name is the `dbTables` key. One physical table can therefore be exposed under several keys, each with its own `operations`, `onRequests`, `tenantScope`, `readExclude` and joins.

```ts
import { defineTable, exportTableInfo, buildRelation, buildUpsertRules, buildUpsertRule, ConditionBuilder, Type } from 'fastify-auto-sqlapi';
import type { ValidationError } from 'fastify-auto-sqlapi';
import { SchemaCustomer as Schema } from '../schemas/SchemaCustomer';

export const TableCustomer = defineTable({
  primary: 'id', // or ['agentId', 'teamId']. Composite PK: no get/delete/bulkDelete routes (listing them in `operations` throws, sqlApi.* → 400); use search, update (matches all PK columns), or a custom route.

  // Extra filters: non-column search filters. Not applied as `col = value`, only via the callback. `filters` is typed with schema + extra keys. Not usable under joinLeft (400); use joinMustExist.
  ...exportTableInfo(Schema, Type.Object({ q: Type.String(), dateFrom: Type.String(), dateTo: Type.String() }),
    (condition, filters) => {
      if (filters.q) {
        const or = new ConditionBuilder('OR');
        or.isILike(Schema.col('name'), `%${filters.q}%`);
        or.isILike(Schema.col('email'), `%${filters.q}%`);
        condition.append(or);
      }
      // undefined values are skipped; a missing bound turns isBetween into >= / <=
      condition.isBetween(Schema.col('orderDate'), filters.dateFrom, filters.dateTo);
    }),
  // Unknown filter keys (not a field, extra filter or computed) are 400, on main and every join, over HTTP and sqlApi alike.

  defaultOrder: 'name ASC, id DESC', // fields mapped to columns; computed allowed; unknown tokens pass as raw SQL
  distinctResults: true, // SELECT DISTINCT
  operations: ['search', 'get'], // HTTP route whitelist. OMITTED = ALL ROUTES (default-open). Does not restrict sqlApi.* nor joins pointing at this table.
  onRequests: [async (req, reply) => { // per-table hooks, after the global ones
    if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Forbidden' });
  }],

  // --- field visibility ---
  insertExclude: ['id', 'createdAt'], // MUST list auto-increment PKs (CLI does it). Was `excludeFromCreation` before 0.6.0, now refused by defineTable. Strips CLIENT input on insert only: beforeInsert and the FK auto-fill may still set it. Not a security tool: every field stays updatable (ADR 0004).
  readExclude: ['passwordHash'], // never projected (search, get, default join selection); naming it in filters/conditions/orderBy/aggregations/selection → 400. Still writable. Static, applies to admins too. PK not allowed.
  writeExclude: ['searchVector'], // dropped from insert/update/bulk bodies and in the engines; still readable. For trigger-owned columns; GENERATED columns need nothing. Runs after hooks. Not PK, not also in readExclude (that is excludeColumns).
  schemaOverrides: { email: Type.String({ format: 'email' }) }, // stricter type for WRITE bodies only (responses and filters keep the generated type: stored rows predate the rule). Taken verbatim: no Optional → mandatory, no Nullable → null rejected.

  // --- joins (see Relations) ---
  allowedReadJoins: [buildRelation(Schema, 'id', SchemaOrder, 'customerId', { alias: 'orders' })],
  allowedWriteJoins: [buildRelation(Schema, 'id', SchemaOrder, 'customerId', { alias: 'orders' })],

  // --- upsert: INSERT becomes upsert for that schema, main or write-join child ---
  upsertMap: buildUpsertRules(
    buildUpsertRule(Schema, ['email']), // exactly the PK or one of the Schema's uniqueKeys, checked at startup (old Schemas: regenerate). Views: none.
    buildUpsertRule(SchemaOrder, ['id']),
  ),
  // Each upserted row must carry its key (natural key non-null; PK whole, or absent = plain insert), no two rows of a request may share it → 400. A row must still be insertable (PG: NOT NULL without default is required even for an existing row). Another row's unique value = DB error, never a hijack.

  // --- tenant (see Tenant scope) ---
  tenantScope: { column: 'organization_id' }, // REAL column name

  // --- computed fields (see Computed fields) ---
  computedFields: {
    fullName: ({ db, qiCol }) => ({
      expr: db.dialectName === 'postgres'
        ? `${qiCol('firstName')} || ' ' || ${qiCol('lastName')}`
        : `CONCAT(${qiCol('firstName')}, ' ', ${qiCol('lastName')})`,
      values: [],
      type: Type.String(),
    }),
  },

  // --- validation: after schema validation, before hooks and SQL. Any error → 400, nothing written ---
  validate: async (db, req, main, secondaries) => { // camelCase, secondaries keyed by alias
    const errors: ValidationError[] = []; // [path, code] or [path, code, message]; path = dot path in the request body: main.<field>, secondaries.<alias>.<i>.<field>, '' when not attributable
    if (!main.name) errors.push(['main.name', 'required']);
    (secondaries?.orders ?? []).forEach((o, i) => {
      if (o.total < 0) errors.push([`secondaries.orders.${i}.total`, 'min', 'must be >= 0']);
    });
    return errors;
  },
  validateBulk: async (db, req, items) => { // bulk upsert: called once with [{ main, secondaries? }]; when defined, per-item validate is skipped in bulk. Paths start with items.<i>
    const codes = items.map((i) => i.main.code);
    return new Set(codes).size === codes.length ? [] : [['', 'batch_unique', 'codes must be unique within the batch']];
  },

  // --- hooks: camelCase records, mutations reach the SQL ---
  beforeInsert: async (db, req, record) => {
    record.createdBy = req.user.id;
    record.createdAt = db.expression('NOW()'); // raw SQL value
  },
  beforeUpdate: async (db, req, record) => { // PK present but not in SET
    if (!req.user.isAdmin) delete record.isAdmin; // field-level rules: silent strip here, or 400 in validate
    record.updatedAt = db.expression('NOW()');
  },
  afterInsert: async (db, req, record, secondaryRecords) => {}, // record = input + generated PK; secondaryRecords: RowsByAlias
  afterUpdate: async (db, req, record, secondaryRecords, deletionRecords) => {}, // inside the transaction: throw = rollback
  beforeDelete: async (db, req, id) => {}, // throw aborts; runs after tenant ownership is verified
  afterDelete: async (db, req, id) => {}, // not called on 404
  beforeBulkDelete: async (db, req, ids) => {}, // once; throw aborts the whole batch
  afterBulkDelete: async (db, req, deletedIds) => {}, // once, only the ids actually deleted
  afterRead: async (db, req, rows, ctx) => { // see afterRead
    for (const row of rows) if (row.ssn != null) row.ssn = decrypt(row.ssn);
  },
});
```

Nullable columns are generated as `Type.Optional(Nullable(T))`, i.e. `{ type: ['integer', 'null'] }`. Do not rewrite this as `Type.Union([T, Type.Null()])`, which Ajv `coerceTypes` corrupts (`null`→`0`, `0`→`null`), or as a bare `Type.Optional(T)`, where NULL serializes as `0`/`""`. Response schemas are `Type.Partial`. A `null` in `filters` means `IS NULL`.

Write bodies are closed (`additionalProperties: false`), so a column that is not in the Schema can never be written (no mass assignment). With Fastify's default `removeAdditional: true`, unknown properties are stripped silently. `Fastify({ ajv: { customOptions: { removeAdditional: false } } })` makes them a 400.

Every error the routes return has one envelope, `{statusCode, error, message, requestId, fields?}` (AGENTS_FRONTEND.md, "Errors"): `error` is the reason phrase, `requestId` the log's `reqId`, and every 400 carries `fields` as `ValidationField[]`. Errors the plugin raises itself are 4xx with client-safe messages. To answer in the same shape from a hook, throw `httpError(400, 'Order is closed', { code: 'closed', path: 'main.status' })` (exported); a thrown error with another `statusCode` is rendered as is, without `fields`. Anything else (a constraint violation, a hook throwing without `statusCode`) returns a fixed `{statusCode:500, error, message:"Internal Server Error", requestId}`: the driver error is logged and set as `err.cause`, and no status is remapped. To map it, add a `setErrorHandler` that checks `err.cause.code === '23505'` and returns 409. Errors thrown by `onRequests` are unaffected.

## Relations

```ts
buildRelation(mainSchema, mainField, joinSchema, joinField, {
  alias, // default joinSchema.tableName. Key in requests, responses, secondaries, deletions, dotted notation. Set it only to join one table twice or for a friendlier name. Duplicate alias → throws.
  selection, // default '*'. ['id', 'name', 'total'] or 'id, name, total'; the request may override it in either form
  unique, // false: 1:N child→main (joinField = child FK) → joinMustExist / joinMultiple / joinGroup. true: N:1 parent→main (joinField = parent PK) → joinLeft. joinField is the target's PK → use true.
  fields, // read-only allowlist of the target's fields. Must include joinField. Not on write joins.
  target, // dbTables key whose config governs the joined table (readExclude, tenantScope, afterRead, computed, write rules). Required when several keys expose that table: startup fails until it is set. With one key, that config applies whatever the key is called.
});

allowedReadJoins: [
  buildRelation(SchemaSession, 'createdBy', SchemaUser, 'id', { alias: 'creator', unique: true }),
  buildRelation(SchemaSession, 'updatedBy', SchemaUser, 'id', { alias: 'updater', unique: true, fields: ['id', 'name'] }),
],
```

- **A read join is a read grant on the target.** It runs inside the host's route: the target's `onRequests` and `operations` do not apply, so a table with `operations: []` is still readable through it. The target's `readExclude`, `tenantScope`, `afterRead` and the relation's schema still apply. `fields` narrows that schema, fail-closed: every other field is a 400 in selection, filters, conditions, orderBy and aggregations, and so is a computed field reaching past it. A column added later is not reachable until listed. Use `readExclude` instead to hide a column from the table's own routes too. (ADR 0010, 0011)
- joinLeft adds a real `LEFT JOIN` only when filters or orderBy need the parent; otherwise it runs a side query.
- **Owned children** (translations, `*_info`, composite PK like `(product_id, lang)`): make them a write join on the parent, not a `dbTables` entry. The child FK is auto-filled, and an `upsertMap` rule on the child key lets clients send only the child's own fields: `PUT /rest/product { main, secondaries: { translations: [{ lang: 'en', name: 'Bike' }] } }`. Expose a composite-PK table standalone only when it stands on its own (M:N links).
- **What a write join runs on the child**: its `insertExclude`, `tenantScope` and `beforeInsert`, then the FK auto-fill, which always wins. Not its `validate` or `afterInsert` (ADR 0014).

## Computed fields

A computed field is a SQL expression usable like a field in `filters`, `conditions`, `orderBy`, `computeMin/Max/Sum/Avg` and `joinGroup.aggregations.by`. It is projected only when requested through `selectComputed`.

```ts
computedFields: {
  statusFromMeta: ({ db, qiCol }) => ({ // db: QueryClient (dialectName, dateTrunc, ...)
    expr: db.dialectName === 'postgres'
      ? `${qiCol('metadata')}->>'status'`
      : `JSON_UNQUOTE(JSON_EXTRACT(${qiCol('metadata')}, '$.status'))`,
    values: [], // required: one per `?` marker (mismatch throws)
    type: Type.String(), // required: Swagger + body validation
  }),
  bonus: ({ qiCol }) => ({
    expr: `CASE WHEN ${qiCol('role')} = ? THEN ${qiCol('salary')} ELSE 0 END`, // `?` markers, never $1; `\?` = literal ?
    values: ['admin'],
    type: Type.Number(),
  }),
  displayName: ({ qiCol }) => ({ // translated jsonb column {"en_US": "Bike", ...}
    expr: `${qiCol('name')}->>'${LANG}'`,
    values: [],
    type: Type.String(),
  }),
},
```

- Computed fields are per table: a join's side query uses the target table's computed fields. On joinLeft, `qiCol` adds the alias automatically.
- A name that collides with a schema field or an extra filter throws in `defineTable`.
- Bound `values` work in WHERE and ORDER BY positions. They are rejected (400) in `selectComputed`, `compute`, `aggregations.by` and `defaultOrder`.
- Limits: read-only (not writable), no computed field referencing another, not usable as a joinGroup aggregation field (`sum: [...]` takes schema fields). The expression is evaluated once per use.

## afterRead

The read-side counterpart of `beforeInsert`/`beforeUpdate`: decrypt, unpack, rescale. Declare it on the table that **owns** the column. It then runs wherever those rows surface: `ctx.source` is `get | search | joinMultiple | joinLeft`, and `ctx.alias` names the relation on joins. It is called once per result set and mutates the rows in place.

- It does not run on joinGroup, compute*, or an empty result. It cannot add or remove rows (the COUNT has already run).
- `filters`, `orderBy` and `compute*` act on the **stored** value, so an encrypted column is searched as ciphertext. With a deterministic cipher, encrypt the search value in `extendedCondition`. With a randomized cipher, the column cannot be searched.
- It changes values, not types: the response is serialized with the generated schema (an object in a `text` column becomes `"[object Object]"`). If the stored type and the API type differ, write a custom route.
- For encryption at rest, pair it with `beforeInsert` + `beforeUpdate` (as in the defineTable example). That covers own routes, joins, and writes as a secondary.

## Tenant scope

`getTenantId(req)` returns one of:

- an id → `IN (id)`
- an array → `IN (...)`
- `null` / `undefined` → admin, no filter
- `[]` → no tenant at all: 403 on any scoped table, before SQL runs

`0` and `''` are ordinary ids. The tenant belongs to the request, not to the table: a scoped table is also filtered when it is a join target or a secondary of an unscoped host. So `getTenantId` must tolerate an unauthenticated request (`req.user?.x ?? null`). Tables without `tenantScope` are never filtered.

```ts
tenantScope: { column: 'organization_id' } // direct
tenantScope: { column: 'organization_id', // indirect, via parent FK
  through: { schema: SchemaCustomer, localField: 'customer_id', foreignField: 'id' } }
tenantScope: { anyOf: ['requester_agent_id', 'target_agent_id'] } // row owned by either party
```

All names in a scope are real columns. Naming a camelCase field whose column differs throws at startup. `anyOf` cannot be combined with `column`/`through` (throws). Clients still send the camelCase field.

| | direct | indirect | anyOf |
|---|---|---|---|
| read, get, delete | `AND col IN (...)` | INNER JOIN parent + WHERE | `AND (a IN (...) OR b IN (...))`; NULL never matches; all-NULL row = admin only; outside scope → 404 |
| insert | single tenant: injected; mismatch → 403; multi-tenant without value → 400. Column is optional in the body | FK must belong to tenant (1 query) → 403 | no injection: at least one listed column must hold a tenant id (400 none, 403 all foreign) |
| update | column stripped from SET, added to WHERE | pre-check → 404; changing the FK to another tenant → 403 | all listed columns stripped from SET; outside scope → 404 |
| bulk upsert | injected on every row; `upsertMap` conflict key owned by another tenant → 403 | as insert | anchor rule per item, even for updates; listed columns never in UPDATE SET; conflict with a row outside scope → 403 |
| joins | filtered | filtered | predicate applied in every join family (joinLeft: in the ON clause) |

`anyOf` children written as secondaries follow the anchor rule: the auto-filled parent FK is not an owner.

## sqlApi (application code)

Same code path, bodies and results as the HTTP routes (AGENTS_FRONTEND.md). Validation, hooks, computed fields and tenant scope all run.

```ts
app.get('/billing/:customerId', async (request) =>
  app.sqlApi.search('subscription', {
    filters: { customerId: Number(request.params.customerId), status: 'active' },
    joinMustExist: { orders: { filters: { status: 'pending' } } },
    paginator: { page: 1, itemsPerPage: 50 },
  }, request)); // pass `request` for tenant + hooks; without it: no tenant filter, hooks get undefined

sqlApi.search(table, { filters, conditions, joinMustExist, joinMultiple, joinGroup, joinLeft, select, selectComputed, orderBy, paginator, compute, maxRows }, req?)
// select: main fields to project; the PK, the requested joins' keys and (with distinctResults) the ORDER BY fields are always added
// compute: { sum: ['total'], max: ['total'] } → result.pagination.computed; needs paginator. computeMin/Max/Sum/Avg (one field each) are still accepted and merged into it
sqlApi.get(table, id, req?)
sqlApi.insert(table, { record, secondaries? }, req?)
sqlApi.update(table, { record, secondaries?, deletions? }, req?)
sqlApi.delete(table, id, req?)
sqlApi.bulkUpsert(table, items, req?) // each item writes only its own fields; items need not share keys
sqlApi.bulkDelete(table, ids, req?)

// Standalone (jobs, scripts, tests). Always pass dialect, default is postgres syntax.
const sqlApi = createSqlApi(mysqlQueryable(pool), dbTables, { dialect: 'mysql' });
const sqlApi2 = createSqlApi(createQueryClient(pgQueryable(pgPool), 'postgres'), dbTables, { dialect: 'postgres' });
```

Limits: the engine enforces at most 100 `conditions` per section, 20 `orderBy` parts and an integer `paginator`, for sqlApi too. `maxItemsPerPage` and `maxBulkItems` belong to the routes only: pass `maxRows` to `search`, and cap your own bulk arrays.

## db (QueryClient) and ConditionBuilder

`db` is the hook parameter, or `createQueryClient(pgQueryable(pool) | mysqlQueryable(pool), dialect)`. Use it only for what sqlApi cannot express. It takes real table and column names (`Schema.tableName`, `Schema.col()`), and a camelCase name here is a runtime SQL error. It runs no hooks, no validation and no tenant scope.

```ts
db.insert(table, record, pkCol) // → PK row
db.insertOrUpdate(table, record, conflictKeys, pkCol) // → PK row
db.bulkInsert(table, records, pkCol, chunkSize?) // → PK rows in input order
db.bulkInsertOrUpdate(table, records, conflictKeys, pkCol, chunkSize?)
db.update(table, record, where, extraCondition?) // → affected rows (number)
db.delete(table, where) // → affected rows
db.select({ tableName, columns?, where, values, limit?, orderBy?, joins?, distinct? })
db.query(sql, values) // dialect placeholders ($1 on PG, ? on MySQL)
db.expression('NOW()') // raw SQL value, not parameterized
db.qi(name); db.dialectName; db.cbDialect // quoting, dialect, ConditionBuilder dialect
```

- `pkCol` is a string or an array. Bulk methods issue one statement per distinct column set.
- `conflictKeys` must be a unique key enforced by the DB. PG uses `ON CONFLICT (keys)`. MySQL/MariaDB upsert by key (a probe SELECT per chunk, then INSERT new and UPDATE existing), because `ON DUPLICATE KEY` fires on any unique index. A key matching several rows is refused.
- Called directly, none of the `defineTable` checks apply.

```ts
const cb = new ConditionBuilder('AND', db.cbDialect); // or 'OR'. Operands are raw SQL: db.qi() them.
cb.isEqual(col, v); // also isNotEqual, is[Not]Greater[OrEqual], is[Not]Less[OrEqual]
cb.isLike(col, '%v%'); // also isNotLike, isILike, isNotILike
cb.isBetween(col, from, to); // also isNotBetween; a missing bound → >= / <=
cb.isIn(col, [a, b]); // also isNotIn
cb.isNull(col, true); // also isNotNull; the boolean enables the condition
cb.raw('ST_Distance(point, ?) < ?', [p, 100]); // `?` markers; backend only
cb.append(otherBuilder); // nesting; backend only
// A value of undefined skips the condition. Everything is parameterized.
```

Example: atomically claiming a row, i.e. a guarded state transition or optimistic lock. There is no auto route for this (ADR 0020). The check and the write must be one UPDATE:

```ts
const db = createQueryClient(pgQueryable(fastify.pg), 'postgres');
fastify.post('/requests/:id/claim', async (req, reply) => {
  const col = (f: string) => SchemaRequest.col(f);
  const guard = new ConditionBuilder('AND', db.cbDialect)
    .isNull(db.qi(col('inProgressSince')), true) // the precondition
    .isEqual(db.qi(col('organizationId')), req.user.orgId); // tenant: db applies none
  const affected = await db.update(SchemaRequest.tableName,
    { [col('inProgressSince')]: new Date(), [col('inProgressBy')]: req.user.id },
    { [col('id')]: req.params.id }, guard);
  return affected === 0 ? reply.code(409).send({ message: 'Already claimed or not found' }) : { claimed: true };
});
// Keep the predicate server-chosen: a client-chosen compare column makes `affected` an oracle.
```

## Views

A view (materialized ones included) is an ordinary table config (ADR 0016).

- **Primary key.** A view declares no PK, and the generator never guesses one from the column types.
  - If the view has an `id` column, it is used and flagged as inferred. Check it is unique before enabling get, update or delete.
  - Otherwise the generator writes `primary: 'TODO_pick_a_unique_column'`, `operations: ['search']` and a real `defaultOrder`. That config works as is.
  - `defineTable` throws on an unknown `primary` unless the table is search-only with its own `defaultOrder`.
- **Writes.** The generated template sets `operations: ['search', 'get']`, but this is not a runtime rule. Simple updatable views accept writes on PG and MySQL. Aggregating views fail at the DB with a 500.
- **Nullability.** PG reports every view column as nullable, MySQL reports the real nullability. The generated Schemas therefore differ per dialect. This affects write bodies only.

## Agent surface

A read-only surface for LLM agents, with the plugin as the enforcement layer:

```ts
await app.register(async (instance) => {
  const opts = { DbTables: dbTables, onRequests: [agentAuth] };
  await instance.register(searchRoutes, opts);
  await instance.register(getRoutes, opts);
  await instance.register(agentManifestRoutes, opts); // GET /agent/manifest(.md)
}, { prefix: '/agent' });
```

- **System prompt**: AGENTS_FRONTEND.md (grammar, shipped in the package) + the output of `GET /agent/manifest.md` (this deployment's tables, fields and aliases).
- **Tools**: either a loose generic tool, retrying on the structured 400 `fields[]`, or strict per-table tools from `agentToolSchemas(dbTables, table)`.

## Exports

Everything is imported from `fastify-auto-sqlapi`, so there is nothing else to install:

- `Type`, `Static`, `ConditionBuilder`, `Expression`, `Nullable`
- `defineTable`, `exportTableInfo`, `buildRelation`, `buildUpsertRule(s)`
- `fastifyAutoSqlApi`, `*Routes`, `agentManifestRoutes`, `setupSwagger`
- `SqlApi`, `createSqlApi`, `QueryClient`, `createQueryClient`, `pgQueryable`, `mysqlQueryable`
- `agentToolSchemas`
- Types: `ValidationError`, `ValidatorFn`, `BulkValidatorFn`, `JoinDefinition`, `SearchCondition`, `ConditionMethod`, `DbTables`

Dialects: PG uses `"id"`, `$1` and `RETURNING`. MySQL uses backticks, `?` and `insertId`. MariaDB is like MySQL but has `RETURNING` (10.5+). The CLI uses `pg` / `mysql2`.
