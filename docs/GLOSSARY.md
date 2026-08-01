# Glossary

One name per concept. Use these words in code, tests and docs — a second name for an
existing concept makes search fail and the concept get built twice.

| Term | Meaning |
|---|---|
| Table config | `defineTable()` result describing one table's routes, guards and joins. (not: model, entity) |
| Schema | TypeBox definition of a table's columns, generated from the DB. (not: model) |
| Relation | `buildRelation()` link between two schemas, identified by an alias. (not: association) |
| Alias | Request/response key naming one relation; defaults to the joined table name. |
| `joinMustExist` | Child→main 1:N filter via EXISTS; never returns child rows. |
| `joinMultiple` | Child→main 1:N side query; child rows land in `result.joinMultiple.<alias>`. |
| `joinGroup` | Child→main 1:N aggregations in `result.joinGroup.<alias>`. |
| `joinLeft` | Parent→main N:1 real LEFT JOIN; needs `unique: true` on the relation. |
| Secondaries | Child rows written in the same request as the main row. (not: nested, children) |
| Deletions | Child rows removed in the same request as the main row update. |
| Computed field | Server-side derived value resolved during search. (not: virtual, derived) |
| Extra filter | Non-column search filter declared per table. (not: custom filter) |
| Extended condition | Consumer-supplied SQL fragment merged into a search WHERE. |
| Dotted notation | `orderBy`/condition key counted in parts: 1-part `field`, 2-part `alias.field`, 3-part `alias.fn.field`. (not: parti) |
| Tenant scope | Row-level isolation: `direct` (own column) or `indirect` (via FK). |
| Engine | Dialect-agnostic function performing one operation. (not: service, handler) |
| Route | Fastify plugin exposing an engine over HTTP. (not: controller) |
| Dialect | Per-DB SQL differences (`postgres` \| `mysql`). |
| QueryClient | Connection wrapper the engines run SQL through. (not: db, connection) |
| Paginator | Request object carrying page and items-per-page. (not: pagination, pager) |
| Manifest | Runtime description of a deployment's tables, for agent clients. |
