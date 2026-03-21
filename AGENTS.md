# fastify-auto-sqlapi — Agent Instructions

You are configuring a Fastify server that uses `fastify-auto-sqlapi` to auto-generate CRUD APIs from database tables. Follow these instructions precisely.

## Overview

The plugin generates REST endpoints (search, get, insert, update, delete, bulk upsert, bulk delete) from database table definitions. No ORM — raw SQL. Supports **PostgreSQL**, **MySQL**, and **MariaDB**. The consumer defines table configurations, and the plugin handles routing, validation, and query execution.

## Documentation

- **[AGENTS_BACKEND.md](./AGENTS_BACKEND.md)** — Setup workflow, CLI, schema/table generation, `defineTable()` complete reference, `buildRelation`, `extraFilters` + `extendedCondition`, **SqlApi** (programmatic high-level API for custom routes), ConditionBuilder API, QueryClient API, Swagger, multi-tenant configuration, hooks, key conventions, common backend patterns, FAQ/gotchas, dialect differences.

- **[AGENTS_FRONTEND.md](./AGENTS_FRONTEND.md)** — Generated endpoints overview, search (POST with body filters, conditions/advanced filters using ConditionBuilder methods, query params for ordering/pagination/aggregation), joinFilters (EXISTS-based filtering by related tables), GET, INSERT (with secondaries), UPDATE (with secondaries + deletions), DELETE, bulk upsert, bulk delete, response shapes (PK-only), joins usage, joinGroups/aggregations, pagination, computed values.

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
