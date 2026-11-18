# fastify-auto-sqlapi — backend reference (LLM)

Setting up the plugin and configuring tables. Client request grammar: AGENTS_FRONTEND.md. Upgrading from 0.x: docs/upgrading/1.0.md (index: BREAKING_CHANGES.md).

## Rules

- Everything is a camelCase **schema field name** (request/response bodies, `defineTable` keys — `tenantScope` included —, hooks, `validate`, `sqlApi.*`, `buildRelation`). **Real DB column names** only where you talk to the database yourself: `db.*` (QueryClient) and any SQL string you write. Get them with `col('field')` in `extendedCondition`, `qiCol('field')` in a computed field, `Schema.col('field')` (unquoted) for `db.*`, never type them: columns may be snake_case or camelCase, the generated Schema knows which.
- `sqlApi` = high-level (camelCase, validation, hooks, tenant, joins, computed). `db` = the SQL layer under it (real names, none of that). Not interchangeable.
- **The routes answer their errors with their own handler: an application `app.setErrorHandler` never sees them** and cannot reshape the envelope. To log or report them, add `app.addHook('onError', async (req, reply, error) => …)` before registering the plugin: it runs for every route error, a 500 carrying the driver error under `error.cause`. To change what the client gets, throw `httpError` from a hook or map driver codes in `dbErrors` (the error envelope paragraph under defineTable).
- Do not read `node_modules/fastify-auto-sqlapi/dist/`: internal, unstable, not documentation. If this file does not answer, say so.
- Behaviors that look like bugs but are decisions (docs/adr/): default-open `operations`, non-transactional bulk, every field updatable, a sanitized 500 on DB errors unless mapped in `dbErrors`, joins not running the target's route guards, no conditional/mass update route, `validateBulk` replacing `validate` in bulk, `PUT /rest/:table` taking the PK in `main`. Do not "fix" them.

## CLI: generate Schemas and tables

```ts
// sqlapi.config.ts — CLI only, never read at runtime. These five keys are all that exist, all optional; any other key fails the run.
import type { CliConfig } from 'fastify-auto-sqlapi';
export default {
  connection: process.env.SHOP_DB_URL, // the database to introspect; omit it to use DATABASE_URL. Keep the password in .env, not here
  outputDir: './src/db', // default './src/db'
  schema: 'public', // PostgreSQL only; MySQL/MariaDB introspect the URL's database
  excludeTables: ['knex_*'], // DB table names or * globs: no schema generated, old one removed
  excludeColumns: ['*.password_hash', 'user.internal_*'], // "<table>.<column>" DB names, * globs. The column does not exist for the API at all (no read, write, filter, manifest). Cannot exclude a PK; a pattern leaving a table with no columns fails the run.
} satisfies CliConfig;
```

The connection is one URL whose scheme names the dialect: `postgres://` (or `postgresql://`), `mysql://`, `mariadb://`. First found wins: `--url`, then `connection` in the config, then `DATABASE_URL`. The `.env` in cwd is loaded before the config (a variable already set wins), so with `DATABASE_URL` in `.env` the commands take no argument. No URL → the run fails saying so; there is no default database. A `connection` key whose variable is unset fails too, rather than falling back to `DATABASE_URL`. Another env file: `process.loadEnvFile('.env.local')` at the top of the config. The schema CLI prints the database it introspects, password masked.

```bash
npx sqlapi-generate-schema # src/db/schemas/Schema*.ts — generated, NEVER edit (overwritten); --url <url> for a one-off database
npx sqlapi-generate-tables customer order # src/db/tables/Table*.ts + dbTables.ts — yours to edit
npx sqlapi-generate-tables --all # existing files are skipped, never overwritten
```

Both commands take `--output <dir>` (over the config's `outputDir`) and `--tables a,b` (DB table names; positional names work too). The schema command restricted to some tables neither removes orphan Schemas nor touches the others; without it, a Schema whose table is gone or excluded is deleted. An unknown option fails the run.

- The generated table files detect PKs, `*Id` foreign keys as relations, and put every other key in as commented code.
- The schema CLI prints what it could not decide for you: read that output. It names database-generated columns (`GENERATED ALWAYS AS`, put in the Schema's `generatedFields` and never writable) and views, whose PK the table generator infers or leaves as a TODO (see Views). Identity/auto-increment PKs need no action: the Schema makes them optional and the table generator lists them in `insertExclude`.
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
  dbTables, // required. Record key = route name: { customer } → /search/customer
  dialect: 'postgres', // 'postgres' (default) | 'mysql' | 'mariadb'
  prefix: '/auto', // standard Fastify prefix, applied once. None → /search/customer
  swagger: true, // or { title, description, version, routePrefix }. Needs @fastify/swagger + @fastify/swagger-ui, else warns and continues
  onRequests: [auth], // global hooks on every route
  getTenantId: (req) => req.user?.organizationId, // see Tenant scope: undefined → 401 on scoped tables, TENANT_ADMIN → no filter
  maxItemsPerPage: 1000, // search page cap AND the LIMIT when no paginator is sent → 400 above it
  maxBulkItems: 1000, // bulk array cap → 400 above it
  agentManifest: true, // GET {prefix}/agent/manifest(.md), behind the same onRequests
  debug: true, // log SQL server-side; never changes a response
  exposeDebugInfo: false, // DEV ONLY: add driver error (message, code, constraint, detail, stack) as `debugInfo` on 500s
  decorate: true, // app.sqlApi for your own routes; false on every registration but one
  dbErrors: { '23505': { status: 409, code: 'duplicate' } }, // driver err.code → { status (400–599), code } in fields, translated client-side; yours to list, per DB ('ER_DUP_ENTRY' on MySQL/MariaDB). Unlisted → 500
});
// app.sqlApi is now decorated, usable from any route.

// MySQL/MariaDB: decorate a mysql2/promise pool as `mysql` instead of registering @fastify/postgres
const pool = mysql.createPool({ host, user, password, database });
app.decorate('mysql', pool);
app.addHook('onClose', () => pool.end());
await app.register(fastifyAutoSqlApi, { dbTables, dialect: 'mysql' });

// Several surfaces: register the plugin again under another prefix with `decorate: false` (app.sqlApi belongs to one registration; a second one without it fails at startup). Each registration's routes run with its own options.
// `operations` narrows a registration: intersected with each table's own (a composite-PK table is skipped for get/delete, not refused).
const publicTables = { customer: dbTables.customer }; // a narrower map of your table configs
await app.register(fastifyAutoSqlApi, {
  dbTables: publicTables, prefix: '/public', decorate: false,
  operations: ['search', 'get'], // read-only: no insert/update/delete/bulk
  swagger: true,
});
```

`pg` returns `numeric`/`int8` as strings and shifts `date`/`timestamp` to local time. The plugin leaves `pg.types` alone (global state). If you want numbers and verbatim dates, set this at startup:

```ts
import pg from 'pg';
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => v);
```

HTTP responses coerce a schema field (`"42"` → `42`) through the response schema. The `joinGroup` and `compute` aggregates are not coerced: they reach the client as the driver returns them — strings on `pg` (`"300.00"`, `"4"`), exact for any size. The parsers matter for those, for `sqlApi.*` results and for hook arithmetic; a parsed value beyond `Number.MAX_SAFE_INTEGER` (2^53 − 1) or with more significant digits than a double holds is no longer exact.

## defineTable

Every key except `primary` and `schema` is optional. There is no `tableName` key: the SQL table is `schema.tableName`, and the route/manifest name is the `dbTables` key. One physical table can therefore be exposed under several keys, each with its own `operations`, `onRequests`, `tenantScope`, `readExclude` and joins.

```ts
import { defineTable, buildRelation, ConditionBuilder, Type } from 'fastify-auto-sqlapi';
import type { ValidatorResult } from 'fastify-auto-sqlapi';
import { SchemaCustomer as Schema } from '../schemas/SchemaCustomer.js';
import { SchemaOrder } from '../schemas/SchemaOrder.js';
import { decrypt } from '../../crypto.js'; // yours

export const TableCustomer = defineTable({
  primary: 'id', // or ['agentId', 'teamId']. Composite PK: no get/delete-by-`:id` routes (listing them in `operations` throws, sqlApi.* → 400); read with search, write with update (matches all PK columns), delete with bulkDelete, `{ ids: [{ agentId, teamId }] }`.

  schema: Schema, // required: the generated Schema. Column filters (`col = value`, null → IS NULL) come from it.

  // Extra filters: non-column search filters (a record of fields or a Type.Object). Not applied as `col = value`, only via extendedCondition. Not usable under joinLeft (400); use joinMustExist.
  extraFilters: { q: Type.String(), dateFrom: Type.String(), dateTo: Type.String() },
  extendedCondition: (condition, filters, { col }) => { // `filters` is typed with schema + extra keys
    // col(field): the column quoted and qualified for where this runs (main search, or a join's subquery under its alias). Always use it: a bare Schema.col() is unquoted and unqualified
    if (filters.q) {
      const or = new ConditionBuilder('OR');
      or.isILike(col('name'), `%${filters.q}%`);
      or.isILike(col('email'), `%${filters.q}%`);
      condition.append(or);
    }
    // undefined values are skipped; a missing bound turns isBetween into >= / <=
    condition.isBetween(col('orderDate'), filters.dateFrom, filters.dateTo);
  },
  // Unknown filter keys (not a field, extra filter or computed) are 400, on main and every join, over HTTP and sqlApi alike.

  defaultOrder: 'name ASC, id DESC', // the 1-part orderBy grammar: schema or computed fields, ASC|DESC. No dotted notation, no SQL (an expression → computedFields). Checked at startup
  distinctResults: true, // SELECT DISTINCT
  operations: ['search', 'get'], // HTTP route whitelist. OMITTED = ALL ROUTES (default-open). Does not restrict sqlApi.* nor joins pointing at this table.
  onRequests: [async (req, reply) => { // per-table hooks, after the global ones
    if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Forbidden' });
  }],

  // --- field visibility ---
  insertExclude: ['id', 'createdAt'], // MUST list auto-increment PKs (CLI does it). Strips CLIENT input on insert only: beforeInsert and the FK auto-fill may still set it. A field of the upsertKey is kept: it names an existing row, never a new one (no such row → 400 not_found, ADR 0031). Not a security tool: every field stays updatable (ADR 0004).
  readExclude: ['passwordHash'], // never projected (search, get, default join projection); naming it in filters/conditions/orderBy/aggregations/select → 400. Still writable. Static, applies to admins too. PK not allowed.
  writeExclude: ['searchVector'], // dropped from insert/update/bulk bodies and in the engines; still readable. For trigger-owned columns; GENERATED columns need nothing. Runs after hooks. Not PK, not also in readExclude (that is excludeColumns).
  schemaOverrides: { email: Type.String({ format: 'email' }) }, // stricter type for WRITE bodies only (responses and filters keep the generated type: stored rows predate the rule). Taken verbatim: no Optional → mandatory, no Nullable → null rejected.

  // --- joins (see Relations) ---
  readJoins: [buildRelation(Schema, 'id', SchemaOrder, 'customerId', { alias: 'orders' })],
  writeJoins: [buildRelation(Schema, 'id', SchemaOrder, 'customerId', { alias: 'orders', upsertKey: ['id'] })], // upsertKey: the child rows of this relation upsert on it, and it can be replaced

  // --- upsert: the main row's INSERT (POST /rest, bulk upsert) becomes INSERT … ON CONFLICT (key) DO UPDATE ---
  upsertKey: ['email'], // exactly the PK or one of the Schema's uniqueKeys, checked at startup (old Schemas: regenerate). Views: none. Main rows only; child rows use the relation's upsertKey. Absent: plain INSERT.
  // Each upserted row must carry its key (natural key non-null; PK whole, or absent = plain insert), no two rows of a request may share it → 400. A key field in insertExclude (the generated PK) only names an existing row: none → 400 not_found. A row must still be insertable (PG: NOT NULL without default is required even for an existing row). Another row's unique value = DB error, never a hijack.

  // --- tenant (see Tenant scope) ---
  tenantScope: { column: 'organizationId' }, // schema field, like every key here

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
  // Every hook and validator receives ONE context object: { db, req, ...data }. db = the client the
  // operation runs on (inside a write, the transaction's); req = the request, undefined when sqlApi.*
  // is called without one (guard req?.user). Data keys: record, secondaries, deletions, rows, id, ids, main, upsert, replace, parent, items.
  validate: async ({ db, req, main, upsert, replace, parent }) => { // camelCase, the request's child-row sections keyed by alias; parent: { alias, main } when this row arrives as another table's child (ADR 0030), absent on this table's own routes
    const errors: ValidatorResult = []; // { path, code }[], the fields of the 400, as is (no message: no prose, the client translates the code). path = dot path in the request body: main.<field>, upsert.<alias>.<i>.<field>, replace.<alias>.<i>.<field>, '' when not attributable. Anything else (a tuple, a message) → 500
    if (!main.name) errors.push({ path: 'main.name', code: 'required' });
    (upsert?.orders ?? []).forEach((o, i) => { // child rows are untyped: they follow the joined table's schema
      if (Number(o.total) < 0) errors.push({ path: `upsert.orders.${i}.total`, code: 'min' });
    });
    return errors;
  },
  validateBulk: async ({ db, req, items }) => { // bulk upsert: called once with the items as sent, [{ main, upsert?, delete?, replace? }]; when defined, per-item validate is skipped in bulk, so a rule that must hold in bulk is written here too (ADR 0025). Paths start with items.<i>
    const codes = items.map((i) => i.main.code);
    return new Set(codes).size === codes.length ? [] : [{ path: '', code: 'batch_unique' }];
  },

  // --- hooks: camelCase records, mutations reach the SQL ---
  beforeInsert: async ({ db, req, record }) => {
    record.createdBy = req?.user?.id;
    record.createdAt = db.expression('NOW()'); // raw SQL value
  },
  beforeUpdate: async ({ db, req, record }) => { // PK present but not in SET
    if (!req?.user?.isAdmin) delete record.isAdmin; // field-level rules: silent strip here, or 400 in validate
    record.updatedAt = db.expression('NOW()');
  },
  afterInsert: async ({ db, req, record, secondaries, deletions }) => {}, // record = input + generated PK; secondaries: child rows written; deletions: rows a replace removed, and in a bulk upsert the item's delete
  afterUpdate: async ({ db, req, record, secondaries, deletions }) => {}, // inside the transaction: throw = rollback. deletions: rows of delete and of a replace
  beforeDelete: async ({ db, req, id }) => {}, // throw aborts; runs after tenant ownership is verified
  afterDelete: async ({ db, req, id }) => {}, // not called on 404
  beforeBulkDelete: async ({ db, req, ids }) => {}, // once; throw aborts the whole batch. ids: values, or { <field>: value } on a composite PK
  afterBulkDelete: async ({ db, req, ids }) => {}, // once, only the ids actually deleted
  afterRead: async ({ db, req, rows, source, alias }) => { // see afterRead
    for (const row of rows) if (typeof row.ssn === 'string') row.ssn = decrypt(row.ssn);
  },
});
```

Nullable columns are generated as `Type.Optional(Nullable(T))`, i.e. `{ type: ['integer', 'null'] }`. Do not rewrite this as `Type.Union([T, Type.Null()])`, which Ajv `coerceTypes` corrupts (`null`→`0`, `0`→`null`), or as a bare `Type.Optional(T)`, where NULL serializes as `0`/`""`. Response schemas are `Type.Partial`. A `null` in `filters` means `IS NULL`.

Write bodies are closed (`additionalProperties: false`), so a column that is not in the Schema can never be written (no mass assignment). With Fastify's default `removeAdditional: true`, unknown properties are stripped silently. `Fastify({ ajv: { customOptions: { removeAdditional: false } } })` makes them a 400.

Every error the routes return has one envelope, `{statusCode, error, message, requestId, fields?}` (AGENTS_FRONTEND.md, "Errors"): `error` is the reason phrase, `requestId` the log's `reqId`, and every 400 carries `fields` as `ValidationField[]`. Errors the plugin raises itself are 4xx with client-safe messages. To answer in the same shape from a hook, throw `httpError(400, 'Order is closed', { code: 'closed', path: 'main.status' })` (exported). A thrown 4xx is answered with its status and message, plus `fields` when `httpError` was given a `code`; a thrown 5xx is a server failure like any other and becomes the fixed 500 below, its message only in the log. Anything else (a constraint violation, a hook throwing without `statusCode`, a stored value the response schema refuses because the Schema predates a column change: regenerate it) returns a fixed `{statusCode:500, error, message:"Internal Server Error", requestId}`: the driver error is logged under that `requestId`. The plugin maps no code of its own (ADR 0006); to answer one with a status, list its driver code in `dbErrors` with a status and a code of yours: the response keeps the envelope, with the reason phrase as `message`, `fields: [{ path: '', code }]` whatever the status, and no driver detail (ADR 0024). An application `setErrorHandler` never sees these errors: the routes' own handler answers first; an application `onError` hook does see them (see Rules). `sqlApi.*` throws the driver error as is. Errors thrown by `onRequests` are unaffected.

## Relations

```ts signature
buildRelation(mainSchema, mainField, joinSchema, joinField, {
  alias, // default joinSchema.tableName. Key in requests (upsert, delete, replace), responses (secondaries, deletions), dotted notation. Set it only to join one table twice or for a friendlier name. Duplicate alias → throws.
  select, // default fields of the joined rows, e.g. ['id', 'name', 'total']; absent: every readable field. The request's select overrides it. A name the joined schema lacks → throws
  unique, // false: 1:N child→main (joinField = child FK) → joinMustExist / joinMultiple / joinGroup. true: N:1 parent→main (joinField = parent PK) → joinLeft. joinField is the target's PK → use true.
  fields, // read-only allowlist of the target's fields. Must include joinField. Not on write joins.
  target, // dbTables key whose config governs the joined table (readExclude, tenantScope, afterRead, computed, write rules). Required when several keys expose that table: startup fails until it is set. With one key, that config applies whatever the key is called.
  upsertKey, // write joins only: the child rows upsert on this key of the joined table, e.g. ['productId', 'lang']. Exactly its PK or one of its uniqueKeys, checked by defineTable (ADR 0021). Absent: plain INSERT, and the alias takes no `replace`. On a read join → throws.
});
```

```ts in=defineTable
readJoins: [
  buildRelation(SchemaSession, 'createdBy', SchemaUser, 'id', { alias: 'creator', unique: true }),
  buildRelation(SchemaSession, 'updatedBy', SchemaUser, 'id', { alias: 'updater', unique: true, fields: ['id', 'name'] }),
],
```

- **A read join is a read grant on the target.** It runs inside the main table's route: the target's `onRequests` and `operations` do not apply, so a table with `operations: []` is still readable through it. The target's `readExclude`, `tenantScope`, `afterRead` and the relation's schema still apply. `fields` narrows that schema, fail-closed: every other field is a 400 in `select`, filters, conditions, orderBy and aggregations, and so is a computed field reaching past it. A column added later is not reachable until listed. Use `readExclude` instead to hide a column from the table's own routes too. (ADR 0010, 0011)
- joinLeft adds a real `LEFT JOIN` only when filters or orderBy need the parent; otherwise it runs a side query.
- **Owned child rows** (translations, `*_info`, composite PK like `(product_id, lang)`): make them a write join on the parent, not a `dbTables` entry. The child FK is auto-filled, and an `upsertKey` on the relation (`{ alias: 'translations', upsertKey: ['productId', 'lang'] }`) lets clients send only the child's own fields: `PUT /rest/product { main, upsert: { translations: [{ lang: 'en', name: 'Bike' }] } }`. With that key the client can also send the whole set, `replace: { translations: [...] }`: the rows left out are deleted, in the write's transaction — in a bulk upsert, in the item's own (ADR 0029). Expose a composite-PK table standalone only when it stands on its own (M:N links).
- **What a write join runs on the child** (rows of `upsert` and `replace`): its `validate` — or its `validateBulk`, once per alias — before any SQL, after the main table's, with `parent: { alias, main }`. It answers in its own grammar, `main.<field>`, `main` or `''` (`validateBulk`: `items.<j>.main.<field>`, `items.<j>` or `''`; anything else is a 500), re-rooted to `upsert.<alias>.<i>.<field>` (`replace.…` for those rows, `<item>.` in front in a bulk upsert); then its `insertExclude`, the FK auto-fill, its `beforeInsert` (which sees the FK), the FK again, so it always wins, and its `tenantScope`. Not its `afterInsert` (ADR 0014, 0030). The child's `validate` sees the FK only when the request names the parent's key: guard a required-FK rule with `!parent`.

## Computed fields

A computed field is a SQL expression usable like a field in `filters`, `conditions`, `orderBy`, `compute` and `joinGroup.<alias>.by`. It is projected only when listed in the request's `select`: `select: ['*', 'fullName']` returns every readable field plus it (ADR 0028).

```ts in=defineTable
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
- Bound `values` work in WHERE and ORDER BY positions. They are rejected (400) in `select`, `compute`, joinGroup `by` and `defaultOrder`.
- Limits: read-only (not writable), no computed field referencing another, not usable as a joinGroup aggregation field (`sum: [...]` takes schema fields). The expression is evaluated once per use.

## afterRead

The read-side counterpart of `beforeInsert`/`beforeUpdate`: decrypt, unpack, rescale. Declare it on the table that **owns** the column. It then runs wherever those rows surface: `ctx.source` is `get | search | joinMultiple | joinLeft`, and `ctx.alias` names the relation on joins. It is called once per result set and mutates the rows in place.

- It does not run on joinGroup, compute, or an empty result. It cannot add or remove rows (the COUNT has already run).
- `filters`, `orderBy` and `compute` act on the **stored** value, so an encrypted column is searched as ciphertext. With a deterministic cipher, encrypt the search value in `extendedCondition`. With a randomized cipher, the column cannot be searched.
- It changes values, not types: the response is serialized with the generated schema (an object in a `text` column becomes `"[object Object]"`). If the stored type and the API type differ, write a custom route.
- For encryption at rest, pair it with `beforeInsert` + `beforeUpdate` (as in the defineTable example). That covers own routes, joins, and writes as a secondary.

## Tenant scope

`getTenantId(req)` returns one of:

- an id → `IN (id)`
- an array → `IN (...)`
- `TENANT_ADMIN` (exported) → admin, no filter. Admin is declared, never inferred.
- `null` / `undefined` → 401 on any scoped table, before SQL runs: an absent tenant is a missing or failed auth hook, not an admin
- `[]` → no tenant at all: 403 on any scoped table, before SQL runs

`0` and `''` are ordinary ids. The tenant belongs to the request, not to the table: a scoped table is also filtered when it is a join target or a secondary of an unscoped main table. `getTenantId` is called only when a scoped table is in reach, so an unauthenticated request still reads unscoped tables; on scoped ones `req.user?.organizationId` is enough, the missing user becomes the 401. Tables without `tenantScope` are never filtered.

```ts in=app
await app.register(fastifyAutoSqlApi, {
  dbTables,
  getTenantId: (req) => (req.user?.isSuperadmin ? TENANT_ADMIN : req.user?.organizationId),
});
```

```ts in=app
const direct: TenantScope = { column: 'organizationId' };
const indirect: TenantScope = { column: 'organizationId', // via parent FK: column and foreignField are fields of SchemaCustomer
  through: { schema: SchemaCustomer, localField: 'customerId', foreignField: 'id' } };
const eitherParty: TenantScope = { anyOf: ['requesterAgentId', 'targetAgentId'] }; // row owned by either party
// on the table: defineTable({ …, tenantScope: direct })
```

All names in a scope are schema fields: `column`, `anyOf` and `localField` of this table, the indirect `column` and `foreignField` of `through.schema`. The column of a field is accepted too (a 0.6 scope naming columns keeps working); any other name fails `defineTable` at startup. The tenant column must therefore be in the schema: hide it with `readExclude`, never `excludeColumns`. `anyOf` cannot be combined with `column`/`through` (throws).

| | direct | indirect | anyOf |
|---|---|---|---|
| read, get, delete | `AND col IN (...)` | INNER JOIN parent + WHERE | `AND (a IN (...) OR b IN (...))`; NULL never matches; all-NULL row = admin only; outside scope → 404 |
| insert | single tenant: injected; mismatch → 403; multi-tenant without value → 400. Column is optional in the body | FK must belong to tenant (1 query) → 403 | no injection: at least one listed column must hold a tenant id (400 none, 403 all foreign) |
| update | column stripped from SET, added to WHERE | pre-check → 404; changing the FK to another tenant → 403 | all listed columns stripped from SET; outside scope → 404 |
| bulk upsert | injected on every row; `upsertKey` conflict owned by another tenant → 403 | as insert | anchor rule per item, even for updates; listed columns never in UPDATE SET; conflict with a row outside scope → 403 |
| joins | filtered | filtered | predicate applied in every join family (joinLeft: in the ON clause) |

`anyOf` child rows written as secondaries follow the anchor rule: the auto-filled parent FK is not an owner.

## sqlApi (application code)

Same code path, bodies and results as the HTTP routes (AGENTS_FRONTEND.md): a request body can be handed over as is. Validation, hooks, computed fields and tenant scope all run.

```ts in=app
app.get<{ Params: { customerId: string } }>('/billing/:customerId', async (request) =>
  app.sqlApi.search('subscription', {
    filters: { customerId: Number(request.params.customerId), status: 'active' },
    joinMustExist: { orders: { filters: { status: 'pending' } } },
    paginator: { page: 1, itemsPerPage: 50 },
  }, request)); // pass `request` for tenant + hooks; without it: no tenant filter, hooks get undefined
```

```ts signature
sqlApi.search(table, { filters, conditions, joinMustExist, joinMultiple, joinGroup, joinLeft, select, orderBy, paginator, compute, maxRows }, req?)
// select: main fields to project, '*' for every readable one; the PK, the requested joins' keys and (with distinctResults) the ORDER BY fields are always added
// compute: { sum: ['total'], count: ['id'] } → result.computed, over every matching row; min|max|sum|avg|count|distinctCount; no paginator needed
sqlApi.get(table, id, req?)
sqlApi.insert(table, { main, upsert?, replace? }, req?) // the POST /rest body: app.sqlApi.insert('customer', req.body, req)
sqlApi.update(table, { main, upsert?, delete?, replace? }, req?) // the PUT /rest body, PK in main
sqlApi.delete(table, id, req?)
sqlApi.bulkUpsert(table, items, req?) // each item writes only its own fields; items need not share keys
sqlApi.bulkDelete(table, { ids }, req?) // the POST /bulk/:table/delete body; composite PK: ids are { <field>: value } objects
// table: a key of dbTables. createSqlApi infers them, so a typo fails at compile time; at runtime an unknown name throws (a programming error, not a 400)
```

```ts in=app
// Standalone (jobs, scripts, tests). Tenant scope needs its own getTenantId, as on the plugin: without it a request passed in scopes nothing. One source for the dialect:
const sqlApi = createSqlApi(mysqlQueryable(pool), dbTables, { dialect: 'mysql', getTenantId: (req) => req.user?.organizationId }); // raw pool: the option, postgres when omitted
const sqlApi2 = createSqlApi(createQueryClient(mysqlQueryable(pool), 'mysql'), dbTables); // QueryClient: its own dialect; a `dialect` option beside it throws
```

Limits: the engine enforces at most 100 `conditions` per section, 20 `orderBy` parts and an integer `paginator`, for sqlApi too. `maxItemsPerPage` and `maxBulkItems` belong to the routes only: pass `maxRows` to `search`, and cap your own bulk arrays.

## db (QueryClient) and ConditionBuilder

`db` is the hook parameter, or `createQueryClient(pgQueryable(pool) | mysqlQueryable(pool), dialect)`. Use it only for what sqlApi cannot express. It takes real table and column names (`Schema.tableName`, `Schema.col()`), and a camelCase name here is a runtime SQL error. It runs no hooks, no validation and no tenant scope.

```ts signature
db.insert(table, record, pkCol) // → PK row
db.upsert(table, record, conflictKeys, pkCol) // → { pk, action: 'inserted' | 'updated' }
db.bulkInsert(table, records, pkCol, chunkSize?) // → PK rows in input order
db.bulkUpsert(table, records, conflictKeys, pkCol, { chunkSize?, immutableCols? }?) // → [{ pk, action }] in input order. immutableCols: written on insert, never on update
db.update(table, record, where, extraCondition?) // → affected rows (number)
db.delete(table, where) // → affected rows
db.select({ tableName, columns?, where, values, limit?, orderBy?, joins?, distinct? })
db.query(sql, values) // dialect placeholders ($1 on PG, ? on MySQL)
db.expression('NOW()') // raw SQL value, not parameterized
db.qi(name); db.dialectName; db.cbDialect // quoting, dialect, ConditionBuilder dialect
```

- `pkCol` is a string or an array. Bulk methods issue one statement per distinct column set.
- Values: string, number, boolean, null, `Date` (bound as a timestamp), `db.expression(...)`. `JSON.stringify` a JSON value first: the drivers do not serialize objects as JSON.
- `conflictKeys` must be a unique key enforced by the DB. PG uses `ON CONFLICT (keys)`. MySQL/MariaDB upsert by key (a probe SELECT per chunk, then INSERT new and UPDATE existing), because `ON DUPLICATE KEY` fires on any unique index. A key matching several rows is refused.
- `action` comes from the statement on PG (`(xmax = 0)` in RETURNING; on `DO NOTHING`, the rows RETURNING names are the inserted ones) and from the probe on MySQL/MariaDB. No extra statement either way.
- Called directly, none of the `defineTable` checks apply.

```ts signature
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

```ts in=app
const db = createQueryClient(pgQueryable(fastify.pg), 'postgres');
fastify.post<{ Params: { id: string } }>('/requests/:id/claim', async (req, reply) => {
  if (!req.user) return reply.code(401).send(); // never let an undefined tenant reach the guard: isEqual would skip it
  const col = SchemaRequest.col;
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

```ts in=app
await app.register(fastifyAutoSqlApi, {
  dbTables, prefix: '/ai', decorate: false, onRequests: [agentAuth],
  operations: ['search', 'get'],
  agentManifest: true, // GET /ai/agent/manifest(.md), listing this registration's operations
});
```

- **System prompt**: AGENTS_FRONTEND.md (grammar, shipped in the package) + the output of `GET {prefix}/agent/manifest.md` (this registration's tables, fields and aliases).
- **Tools**: either a loose generic tool, retrying on the structured 400 `fields[]`, or strict per-table tools from `agentToolSchemas(dbTables, table, { operations })` (pass the registration's `operations` and caps).

## Exports

Everything is imported from `fastify-auto-sqlapi`, so there is nothing else to install:

- `fastifyAutoSqlApi` (the one way to mount the routes), `SqlApi`, `createSqlApi`
- `defineTable`, `buildRelation`, `Nullable`, `Type`, `Static`, and the TypeBox types the signatures name: `TSchema`, `TObject`, `TUnsafe`
- for hooks: `httpError`, `TENANT_ADMIN`, `ConditionBuilder`, `Expression`, `ConditionValueOrUndefined`
- `QueryClient`, `createQueryClient`, `pgQueryable`, `mysqlQueryable`, and their parameter types `PgQueryable`, `MysqlQueryable`
- `agentToolSchemas`, `buildAgentManifest`, `renderAgentManifestMd`
- Types: those of the config (`DbTables`, `TableDefinition`, `TableConfig`, `JoinDefinition`, `BuildRelationOptions`, `TenantScope`…), of the hooks (`ApiRequest`, `ApiReply`, `ValidationField`, `ValidatorFn`, `ValidatorResult`, `BulkValidatorFn`, `WriteHookContext`, `PrimaryKeyValue`…), of `sqlApi` (`SqlApi*Params`, `JoinFetchRequest`, `JoinRefFilter`, `SearchResult`…), of the QueryClient (`BulkUpsertOptions`…), of the agent manifest (`AgentManifest`, `ManifestTable`, `ManifestField`, `ManifestJoin`) and of the CLI (`CliConfig`). Every type a public signature names is exported, except the building blocks of an exported one

Nothing else is public: the engines, route plugins, schema builders, naming helpers, dialect table and tenant resolution are internals.

Dialects: PG uses `"id"`, `$1` and `RETURNING`. MySQL uses backticks, `?` and `insertId`. MariaDB is like MySQL but has `RETURNING` (10.5+). The CLI uses `pg` / `mysql2`.
