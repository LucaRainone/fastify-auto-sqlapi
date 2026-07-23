# fastify-auto-sqlapi — Agent Instructions

You are configuring a Fastify server that uses `fastify-auto-sqlapi` to auto-generate CRUD APIs from database tables. Follow these instructions precisely.

## Overview

The plugin generates REST endpoints (search, get, insert, update, delete, bulk upsert, bulk delete) from database table definitions. No ORM — raw SQL. Supports **PostgreSQL**, **MySQL**, and **MariaDB**. The consumer defines table configurations, and the plugin handles routing, validation, and query execution.

## Documentation

- **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** — **READ FIRST when migrating.** Maps the old join API (`joinFilters`, `joins`, `joinGroups`) to the new alias-based one (`joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft`). Covers `buildRelation` new options-object signature (alias defaults to `joinSchema.tableName`, plus `selection` and `unique`), request/response key renames, secondaries key renames, dotted notation rules, and validation/400 errors. Common to backend and frontend.

- **[AGENTS_BACKEND.md](./AGENTS_BACKEND.md)** — Setup workflow, CLI, schema/table generation, `defineTable()` complete reference, `buildRelation` (alias + unique), `extraFilters` + `extendedCondition`, **SqlApi** (programmatic high-level API for custom routes), ConditionBuilder API, QueryClient API, Swagger, multi-tenant configuration, **validation** (`validate` + `validateBulk`), hooks, key conventions, common backend patterns, FAQ/gotchas, dialect differences.

- **[AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md)** — Generated endpoints overview, search (POST with body filters, conditions/advanced filters using ConditionBuilder methods, query params for ordering/pagination/aggregation), `joinMustExist` (EXISTS-based filtering by related tables), `joinMultiple` (fetch child rows), `joinGroup` (aggregations), `joinLeft` (embed N:1 parent inline), GET, INSERT (with secondaries), UPDATE (with secondaries + deletions), DELETE, bulk upsert, bulk delete, response shapes (PK-only), **validation errors** (structured field-level 400 responses), pagination, computed values.

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
