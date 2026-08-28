# fastify-auto-sqlapi

**Your database already knows its tables, columns and relations. This plugin turns that knowledge into a typed, validated REST API inside your [Fastify](https://fastify.dev/) app.**

```typescript
await app.register(fastifyAutoSqlApi, { DbTables: dbTables, swagger: true, prefix: '/api' });
```

### One `register()` call. Seven endpoints for every table you choose to expose.

No ORM. No GraphQL. No hand-written CRUD layer. Two CLI commands read PostgreSQL / MySQL /
MariaDB and generate typed schemas; the database stays the source of truth, and what you write
is what a database cannot know — auth, permissions, business rules — as plain TypeScript next to
your other routes.

Related tables need no endpoints of their own: reads reach them through joins, writes through
nested children, so a whole subgraph can live behind a single exposed table.

## See what that buys you

*"Active customers with over 500 total in completed orders, with their order stats, biggest
spenders first."* No resolver, no query builder, no one-off endpoint:

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

And multi-tenancy is one plugin option (`getTenantId: (req) => req.user?.organizationId ?? null`), enforced on reads *and* writes with zero code in handlers. Rows of other tenants are simply invisible (`404`); here a caller in org B tries to re-point one of their own orders to a customer belonging to org A:

```jsonc
// PUT /api/rest/order — order 7 is mine, customer 41 belongs to another tenant
{ "main": { "id": 7, "customerId": 41 } }
// → 403 Forbidden — cross-tenant references are rejected server-side
```

No endpoint written by hand, no resolvers, no query language on the server — and these requests are schema-validated, Swagger-documented, size-capped and tenant-isolated like every other one.

## What you get

**Reads** — filters and equality shortcuts · advanced conditions (18 operators) · pagination
with caps · four explicit relation families (`joinMustExist` for EXISTS filtering,
`joinMultiple` for child rows, `joinGroup` for aggregations, `joinLeft` for N:1 parents) ·
aggregations with HAVING-style conditions · ordering by related and computed values · computed
fields declared as SQL expressions (JSON extraction, derived strings, date bucketing)

**Writes** — validated inserts and updates · nested child records with foreign keys filled in
from the parent · child deletions in the same request · bulk upsert and bulk delete ·
transactions, so a write and its children commit or roll back together

**Production** — multi-tenant row isolation from one `getTenantId`, enforced on reads *and*
writes · hooks before and after every operation, plus `afterRead` · field-level and
cross-entity validation returning structured `400`s · per-table route whitelists · read and
write column visibility · Swagger from the same schemas · request-size and pagination caps ·
plain parameterized SQL you can print with `debug: true`

Views are table configs like any other, materialized views included. And when generated CRUD
stops being the right abstraction, call `app.sqlApi.*` from a hand-written route: you keep the
filters, joins, tenant scoping, hooks and validation, and drop only the assumption that the
endpoint looks like a table.

### N+1 is structurally absent

A request runs the main select plus one query per requested join alias — a number fixed by the
request, **never by the number of rows returned**. There are no lazy relations to accidentally
loop over, so N+1 is not something you have to remember to avoid.

## Is this for you?

**Yes, if you are building an internal tool** — a back-office, an admin panel, a management
system where superadmin, admin and tenant-admin roles need full control over the domain. There
the database schema *is* the domain model, and whoever changes a column is whoever changes the
screen that shows it. A hand-written CRUD layer in the middle has no reader: it exists only to
be kept in sync with the thing it translates.

Concretely, it fits when:

- most of your endpoints are "list with filters", "get one", "save", "save many"
- the people who change the schema also ship the client
- you want tenant isolation, validation, pagination caps and Swagger without writing them per table
- the interesting logic is *rules* (who may do what, what must be valid) rather than *shapes*

**No, if you are publishing an API you do not control the consumers of.** A public or
third-party API — a contract with a version number and a deprecation policy, clients you cannot
redeploy alongside your schema — needs a surface whose stability outlives your refactors. That
indirection is worth paying for there, and generating it from the schema is the wrong default.
Also a poor fit if your endpoints are mostly workflows rather than records, or if your data
model is deliberately nothing like your API model.

It is not all-or-nothing: `operations` keeps any table off the auto routes, and a table with no
routes at all can still be reached through a join or written as a nested child. Expose the CRUD
that is CRUD, hand-write the rest.

## Get a REST API in 60 seconds

```bash
npm install fastify-auto-sqlapi fastify @fastify/postgres
# MySQL / MariaDB: npm install fastify-auto-sqlapi fastify mysql2
```

Create `sqlapi.config.ts` in the project root (used by the CLI only, not at runtime), then:

```bash
npx sqlapi-generate-schema     # one TypeBox schema per table → <outputDir>/schemas/
npx sqlapi-generate-tables --all   # one defineTable() template per table → <outputDir>/tables/
```

Schema files are regenerated on every run and should not be edited. **Table files are yours**:
the generator never overwrites one that exists, so re-running only adds files for new tables.

```typescript
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';
import { dbTables } from './src/db/tables/dbTables.js';

const app = Fastify();
await app.register(fastifyPostgres, { connectionString: 'postgres://user:pass@localhost:5432/mydb' });
await app.register(fastifyAutoSqlApi, { DbTables: dbTables, swagger: true, prefix: '/api' });
await app.listen({ port: 3000 });
```

For a table called `customer` you now have:

| Method | URL | |
|--------|-----|---|
| `POST` | `/api/search/customer` | search with filters, pagination, joins, aggregations |
| `GET` | `/api/rest/customer/:id` | get one by primary key |
| `POST` | `/api/rest/customer` | insert (+ nested children) |
| `PUT` | `/api/rest/customer` | update (+ nested children and deletions) |
| `DELETE` | `/api/rest/customer/:id` | delete by primary key |
| `PUT` | `/api/bulk/customer` | bulk upsert |
| `POST` | `/api/bulk/customer/delete` | bulk delete |

Search is a `POST` because the filters travel as JSON in the body. Every option of `defineTable()` and of `register()` is documented in
[AGENTS_BACKEND.md](./AGENTS_BACKEND.md); the full request grammar is in
[AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md).

## Why this approach

The first objection is always that this couples the API to the database. It does, deliberately,
and the answer is worth stating precisely.

**A hand-written CRUD layer over the same tables is coupled to the same schema** — it just
retypes it. Rename a column there and you edit the model, the DTO, the mapper, the validator,
the Swagger annotation and the client: six places instead of one, and the coupling is still
there. What that layer really buys is an indirection that lets the contract stay still while the
schema moves — worth wanting, paid for continuously, cashed in rarely. This plugin makes the
opposite bet, and the bet is the point.

**The coupling is checked, not implied.** Schemas are generated from `information_schema`, so a
schema change that breaks the API breaks it when you regenerate and compile. A hand-written
mapper nobody remembered to update fails in production instead.

**And it is a default, not a fact.** Your schema defines the shape; your code defines the rules.
The shape you expose is not forced to be the shape you store — there is a specific lever for
each way they need to differ:

| To decouple | Use |
|---|---|
| a column must never be read | `readExclude` |
| a column must never be written | `writeExclude` |
| a column must not exist for the API at all | trim it out of the Schema |
| the API type must be stricter than the column | `schemaOverrides` |
| the value is derived, not stored | `computedFields` |
| the stored representation is not the API one | `afterRead` (decrypt, unpack, rescale) |
| a table must not have all seven routes | `operations` |
| a relation must be named for the API, not the DB | the relation `alias` and its `fields` allowlist |
| a filter has no column behind it | `extraFilters` |

When none of them fits, the operation was never CRUD: write the route by hand and call
`app.sqlApi.*` inside it — you keep filters, joins, tenant scoping, hooks and validation, and
drop only the assumption that the endpoint looks like a table. Full rationale in
[ADR 0017](./docs/adr/0017-the-schema-is-the-contract.md).

### Not an ORM, not GraphQL — a third thing

- **Not an ORM.** An ORM is a library *your* code uses to talk to the database — you still
  hand-write every endpoint on top of it. This generates the endpoints themselves, with no ORM
  underneath: no models, no migrations, no second schema to keep in sync. Every request runs as
  plain parameterized SQL you can read with `debug: true`.
- **Not GraphQL.** GraphQL buys client-driven flexibility with a schema layer, hand-written
  resolvers and their N+1 traps, mutations one by one, and query-cost analysis to stop hostile
  requests. This covers what most projects reach for GraphQL for — filter, paginate, join,
  aggregate in one round trip — with a fixed JSON grammar over plain REST: curl-able,
  Swagger-documented, bounded by design. The write side is generated too. What you give up:
  arbitrarily deep nesting, per-field selection on the main table, subscriptions.
- **Not a hosted black box.** PostgREST / Hasura / Supabase give you an API as a separate
  service, configured from outside. This is a plugin inside your own app: hooks, validation and
  auth are TypeScript functions in your codebase, and you can always drop to `app.sqlApi.*` or
  raw SQL in a custom route. No lock-in.

Queries are set-based: the main select plus one per requested join alias, **never one per
returned row**. There are no lazy relations to loop over — N+1 is structurally absent, not
something you remember to avoid.

## Before you ship

> ⚠️ **The plugin is open by default.** Registering it with no further configuration exposes
> **every operation on every table in `DbTables`** — reads *and* writes, bulk delete included —
> to anyone who can reach the server. That is intentional: the plugin provides the tools and
> imposes no auth model ([ADR 0002](./docs/adr/0002-open-by-default.md)). Locking it down is
> yours to do.

Five things decide whether a deployment is safe. Each is one option, and each is covered in
full in [AGENTS_BACKEND.md](./AGENTS_BACKEND.md).

**1. Who may call the routes** — `onRequests` runs before every generated route, globally or per
table. It is where `jwtVerify()` and your role checks go.

**2. Which routes exist** — `operations: ['search', 'get']` registers only those; the rest answer
404. It gates HTTP only: your own code still reaches everything through `app.sqlApi.*`.

**3. A declared join is a read grant.** Neither of the two above follows a join: a join is
resolved inside the *host* table's query, so the target's hooks never run and its `operations`
whitelist does not apply. A table with `operations: []` is still fully readable through any
relation pointing at it. `allowedReadJoins` is therefore a security decision — and
`buildRelation(..., { fields: ['id', 'name'] })` narrows what a relation exposes, fail-closed.
([ADR 0010](./docs/adr/0010-joins-do-not-run-route-guards.md),
[ADR 0011](./docs/adr/0011-join-fields-allowlist.md))

**4. Every Schema field is updatable by default.** `excludeFromCreation` is an ergonomics tool
for inserts, not a security mechanism, and it deliberately does not apply to updates. So
`isAdmin`, roles, ownership and state columns *will* be accepted by the generated update route
if they are in the Schema. Whether a field may change is a product decision the plugin cannot
make for you — encode it in `beforeUpdate` (silent strip) or `validate` (loud 400), or keep the
privileged transition off the auto routes entirely.
([ADR 0004](./docs/adr/0004-updates-always-open.md))

**5. What leaves the server.** Any error the plugin did not raise itself becomes a bare `500`
carrying a `requestId` — driver messages name your tables, columns and constraints, and they
stay in the log. No status code is remapped (a unique violation is a `500`, not a `409`: that
mapping is product logic, for your `setErrorHandler`). Set `exposeDebugInfo: true` while
developing to get the driver detail on the wire, additively.
([ADR 0013](./docs/adr/0013-sanitized-db-errors.md))

Two caps are on by default: `maxItemsPerPage` (1000) bounds a search — and is applied as the
`LIMIT` even with no paginator, so an empty-body search cannot dump a table — and `maxBulkItems`
(1000) bounds a bulk array. Write bodies are `additionalProperties: false`, so the Schema is the
write whitelist and there is no mass assignment; note that Fastify *strips* an unknown field by
default rather than rejecting it.

## Documentation

| | |
|---|---|
| [AGENTS_BACKEND.md](./AGENTS_BACKEND.md) | **The reference.** Setup, plugin options, every `defineTable()` key, joins, computed fields, hooks, validation, multi-tenancy, views, `SqlApi`, `QueryClient`, Swagger, patterns, FAQ. Opens with a section map — jump, don't scan. |
| [AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md) | **The client contract.** Every endpoint's request and response shape, the four join families, conditions, ordering, pagination, error shapes. |
| [docs/adr/](./docs/adr/README.md) | **Why it behaves like this.** Open-by-default, non-transactional bulk, always-updatable fields, raw DB errors, the schema-as-contract bet. Read the relevant one before filing an issue that proposes changing one of these. |
| [CHANGELOG.md](./CHANGELOG.md) · [BREAKING_CHANGES.md](./BREAKING_CHANGES.md) | What changed, and how to migrate. |

The two `AGENTS_*` files are named for their other audience — they ship inside the npm package
so a coding agent finds them after `npm install` — but they are the reference documentation for
people too, and they are written to be read. Point an agent at them once:

> Read `node_modules/fastify-auto-sqlapi/AGENTS.md` before touching anything under `src/db/`.

Three properties make the generated configuration reviewable, by a person or by an agent: a
table is **one local `defineTable()` call** with nothing to wire across files; there is **one
naming convention** (camelCase in requests, responses, hooks and validators — the mapping to DB
columns is automatic); and a `400` carries `fields: [{ path, code, message }]`, so a failing
request says exactly what to fix.

## Requirements

- Node.js >= 18, Fastify >= 5 (peer dependency)
- **PostgreSQL** + `pg` + `@fastify/postgres`, or **MySQL** / **MariaDB** + `mysql2`
- Optional: `@fastify/swagger` + `@fastify/swagger-ui` for Swagger UI

## License

MIT
