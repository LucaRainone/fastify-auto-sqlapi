# fastify-auto-sqlapi — agent instructions

A Fastify plugin that generates REST CRUD endpoints (search, get, insert, update, delete, bulk upsert, bulk delete) from database tables. No ORM, raw SQL. PostgreSQL, MySQL, MariaDB.

## Which file to read

- Calling the API (fetch, list page, form, agent tool): AGENTS_FRONTEND.md, whole file. It is the complete request grammar.
- This deployment's tables, fields and join aliases: `GET {prefix}/agent/manifest.md` (when `agentManifest` is on) or Swagger. The docs give the grammar, the manifest gives the vocabulary.
- Setting up the plugin, configuring tables, joins, tenant scope, hooks, validation, querying from custom routes/scripts/jobs (`sqlApi`), raw SQL in hooks (`db`): AGENTS_BACKEND.md.
- Migrating from the old join API (`joinFilters`, `joins`, `joinGroups`): BREAKING_CHANGES.md.
- A behavior that looks wrong: docs/adr/ first. These include open-by-default `operations`, non-transactional bulk, always-updatable fields, raw DB errors, and joins not running the target's route guards. They are recorded decisions, not gaps.

These files are the contract. **Do not read the plugin's sources** (`node_modules/fastify-auto-sqlapi/dist/`): they are internal, carry no stability guarantee, and say nothing about which behaviors are deliberate. If the docs do not answer, say so and ask. Never copy an internal helper into consumer code.

## The database schema is the API contract, on purpose

The exposed shape follows the stored shape by default, and every part of that default is overridable with these levers:
- `readExclude`, `writeExclude`, `excludeColumns` (CLI)
- `schemaOverrides`, `computedFields`, `afterRead`
- `operations`, relation `alias`/`fields`, `extraFilters`

This has two consequences:
- **Do not add a DTO/mapping layer or reshape responses in a route wrapper.** Use the matching lever (ADR 0017). When none fits, the operation is not CRUD: write a custom route that calls `app.sqlApi.*`. It keeps filters, joins, tenant scoping, hooks and validation.
- **The target is internal surfaces** (back-office and admin tools where the schema is the domain model). If the user is building a public or third-party API (consumers who cannot redeploy with the schema, a versioned contract), say so, and keep those tables off the auto routes via `operations`.

## Naming

- camelCase schema field names everywhere: request/response bodies, `defineTable` keys, `buildRelation`, hooks, validators, `sqlApi.*`.
- Real DB column names only where you address the database yourself:
  - `db.*` (QueryClient) record keys, `where` and `conflictKeys`, plus the real table name `Schema.tableName`;
  - `tenantScope` columns;
  - SQL you write (`extendedCondition`, computed `expr`), where columns come from `Schema.col('field')` / `qiCol('field')` and are never typed literally.

The generated Schema maps between the two, whether the DB uses snake_case or camelCase. Clients always send camelCase, including when anchoring an `anyOf` tenant write.
