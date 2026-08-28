# fastify-auto-sqlapi — Agent Instructions

You are configuring a Fastify server that uses `fastify-auto-sqlapi` to auto-generate CRUD APIs from database tables. Follow these instructions precisely.

## Overview

The plugin generates REST endpoints (search, get, insert, update, delete, bulk upsert, bulk delete) from database table definitions. No ORM — raw SQL. Supports **PostgreSQL**, **MySQL**, and **MariaDB**. The consumer defines table configurations, and the plugin handles routing, validation, and query execution.

## Start here

These files are the **contract**. Everything a consumer can rely on is documented here; find
the answer in the table below and stop there.

| I need to… | Read |
|---|---|
| Call the API from a client (fetch, list page, form, agent tool) | **[AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md)** — whole file, it is the complete request grammar |
| Know *this* deployment's tables, fields and join aliases | `GET {prefix}/agent/manifest.md` (when `agentManifest` is on), or Swagger — the docs give the grammar, the manifest gives the vocabulary |
| Add or configure a table, joins, tenant scope, hooks, validation | **[AGENTS_BACKEND.md](./AGENTS_BACKEND.md)** — see its section map |
| Query the data from a custom route, a script or a background job | AGENTS_BACKEND.md → *SqlApi* |
| Run raw SQL inside a hook | AGENTS_BACKEND.md → *QueryClient API* |
| Migrate from the old join API (`joinFilters`, `joins`, `joinGroups`) | **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** |
| Understand why a behavior that looks wrong is intended | **[docs/adr/](./docs/adr/README.md)** |

**Do not read the plugin's own sources.** `node_modules/fastify-auto-sqlapi/dist/` is compiled
output: internal helpers, no stability guarantee, and no indication of which behaviors are
deliberate. An answer reverse-engineered from it is right today and wrong at the next release.
If a question is not answered by the files above, say so and ask — do not infer the API from
the implementation, and never copy an internal helper into consumer code.

## Naming: camelCase in code, real column names only when you address the DB directly

Everything the plugin exposes is a **camelCase schema field name**. The database is free to name
its columns however it likes: snake_case columns (`organization_id`) are converted to camelCase
(`organizationId`) for the code, and columns already in camelCase (e.g. betterauth) are preserved
verbatim through the `colMap` the CLI generates. Either way `Schema.col('organizationId')` returns
the real column — the mapping lives in the generated Schema, so no naming convention is imposed on
the database and none has to be remembered. One rule: **write camelCase everywhere except where
you name a column to the database yourself.**

| camelCase — schema field names | real column names — whatever the table uses |
|---|---|
| every request and response body: `filters`, `conditions`, `orderBy`, `selectComputed`, `main`, secondaries | `db.*` (QueryClient) calls: record keys, `where`, `conflictKeys` — and the real table name (`Schema.tableName`), not the schema variable |
| `defineTable` keys: `primary`, `excludeFromCreation`, `readExclude`, `schemaOverrides`, `buildUpsertRule(Schema, […])` | `tenantScope`: `column`, `anyOf[…]`, `through.localField` / `through.foreignField` |
| `buildRelation(Main, mainField, Join, joinField)` | any SQL string you write yourself — `extendedCondition`, `computedFields.expr`: get the column with `Schema.col('field')` or `qiCol('field')`, never type it literally |
| hooks and validators — `validate`, `beforeInsert`/`afterInsert`, `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`, `afterRead` — receive and mutate camelCase records | |
| `sqlApi.search / get / insert / update / delete / bulkUpsert / bulkDelete` — same shapes as the HTTP bodies | |

Two consequences worth remembering: a `tenantScope` names the table's own columns (as in
`{ anyOf: ['requester_agent_id', 'target_agent_id'] }` for a snake_case table) while the client
still anchors the write by sending `requesterAgentId`; and `sqlApi` and `db` are **not**
interchangeable — `sqlApi` is the high-level API (camelCase, hooks, tenant, joins), `db` is the SQL
layer underneath it (real column names, no hooks, no tenant).

## Documentation

- **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** — **READ FIRST when migrating.** Maps the old join API (`joinFilters`, `joins`, `joinGroups`) to the new alias-based one (`joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`). Covers `buildRelation` new options-object signature (alias defaults to `joinSchema.tableName`, plus `selection` and `unique`), request/response key renames, secondaries key renames, dotted notation rules, and validation/400 errors. Common to backend and frontend.

- **[AGENTS_BACKEND.md](./AGENTS_BACKEND.md)** — Setup workflow, CLI, schema/table generation, `defineTable()` complete reference, `buildRelation` (alias + unique), `extraFilters` + `extendedCondition`, **SqlApi** (programmatic high-level API for custom routes), ConditionBuilder API, QueryClient API, Swagger, multi-tenant configuration, **validation** (`validate` + `validateBulk`), hooks, key conventions, common backend patterns, FAQ/gotchas, dialect differences.

- **[AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md)** — Compact client-side request grammar (LLM-oriented, also the system-prompt reference for runtime agent clients): all endpoints, search with the four join families (`joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`), conditions methods, ordering (including dotted notations), pagination, writes with secondaries/deletions, structured 400 error shape. Pair with `GET {prefix}/agent/manifest.md` (when `agentManifest` is enabled) for this deployment's tables/fields/aliases.

- **[docs/adr/](./docs/adr/README.md)** — Architecture Decision Records. **Read before proposing a "fix" to a deliberate behavior**: open-by-default, non-transactional bulk, always-updatable fields, raw DB errors, insert-pipeline ordering. These are recorded decisions with rationale, not gaps.

## Quick Reference

### Generated endpoints

For a table `customer` with `prefix: '/auto'`:

```
POST   /auto/search/customer           — search with filters in body
GET    /auto/rest/customer/:id         — get single record by PK
POST   /auto/rest/customer             — insert record (+ secondaries)
PUT    /auto/rest/customer             — update record (+ secondaries + deletions)
DELETE /auto/rest/customer/:id         — delete record by PK
PUT    /auto/bulk/customer             — bulk upsert (array of items)
POST   /auto/bulk/customer/delete      — bulk delete (array of PKs)
```

### Minimal setup

```typescript
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';
import { dbTables } from './src/db/tables/dbTables.js';

const app = Fastify();
await app.register(fastifyPostgres, { connectionString: 'postgres://...' });
await app.register(fastifyAutoSqlApi, { DbTables: dbTables, swagger: true });
await app.listen({ port: 3000 });
```

### Minimal table definition

```typescript
import { defineTable, exportTableInfo } from 'fastify-auto-sqlapi';
import { SchemaCustomer as Schema } from '../schemas/SchemaCustomer';

export const TableCustomer = defineTable({
  primary: 'id',
  excludeFromCreation: ['id'],  // MUST include auto-increment PKs
  ...exportTableInfo(Schema),
});
```

### Joins at a glance

| Family | Direction | Cardinality | Output |
|--------|-----------|-------------|--------|
| `joinMustExist` | child → main | 1:N | filters main via EXISTS |
| `joinMultiple` | child → main | 1:N | side query, child rows in `result.joinMultiple.<alias>` |
| `joinGroup` | child → main | 1:N | aggregations in `result.joinGroup.<alias>` |
| `joinLeft` | parent → main | N:1 | real LEFT JOIN (on demand), parent rows in `result.joinLeft.<alias>` |

Declare relations with `buildRelation(M, mF, J, jF, options?)`. Options are all optional: `alias` defaults to `joinSchema.tableName` (override only when joining the same table twice or to use a friendlier name), `selection` defaults to `'*'`, `unique` defaults to `false`. Set `unique: true` for N:1 (parent) relations to enable `joinLeft`. See [BREAKING_CHANGES.md](./BREAKING_CHANGES.md) for the full migration guide.
