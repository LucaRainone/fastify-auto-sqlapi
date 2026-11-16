# Glossary

One name per concept. Use these words in code, tests and docs — a second name for an
existing concept makes search fail and the concept get built twice.

| Term | Meaning |
|---|---|
| Table config | `defineTable()` result describing one table's routes, guards and joins; type `TableConfig`. (not: model, entity; `ITable` before 0.6.0) |
| Schema | TypeBox definition of a table's columns, generated from the DB. (not: model) |
| Relation | `buildRelation()` link between two schemas, identified by an alias. (not: association) |
| Alias | Request/response key naming one relation; defaults to the joined table name. |
| Target | The `dbTables` key whose table config governs a relation's joined table; required when that table sits under several keys. (not: joinConf, childConf in config) |
| `joinMustExist` | Child→main 1:N filter via EXISTS; never returns child rows. |
| `joinMultiple` | Child→main 1:N side query; child rows land in `result.joinMultiple.<alias>`. |
| `joinGroup` | Child→main 1:N aggregations: `by` and the functions in the request, `result.joinGroup.<alias>.rows` (`{ by?, <fn>: { <field> } }`) in the response. |
| `joinLeft` | Parent→main N:1 real LEFT JOIN; needs `unique: true` on the relation. |
| Main | The principal row of a write request: `main` in the HTTP body, in `sqlApi.insert`/`update` and in `validate`. (not: record, in a request) |
| Record | One row a hook is writing: `record` in `beforeInsert`/`beforeUpdate`/`afterInsert`/`afterUpdate`. A main row or a secondary of another table alike. (not: main, in a hook) |
| Secondaries | Child rows written in the same request as the main row; `secondaries` in a write response and in `afterInsert`/`afterUpdate`. (not: nested, children) |
| Deletions | Child rows removed in the same request as the main row; `deletions` in a write response and in `afterUpdate`. |
| Parent | The main row a child row is written with, as the child table's `validate` sees it: `parent: { alias, main }`; absent on the table's own routes. (not: host, owner, in a hook) |
| `upsert` / `delete` / `replace` | The request sections naming child rows, by write alias: write these, delete these, these are all of them (the others are deleted). (not: secondaries, deletions — those are the outcome) |
| Computed field | Server-side derived value resolved during search. (not: virtual, derived) |
| Hook context | The single object every hook and validator receives: `db`, `req` (may be undefined) and the operation's data under the names above (`record`, `secondaries`, `deletions`, `rows`, `id`, `ids`, `main`, `upsert`, `replace`, `parent`, `items`). (not: positional args) |
| Extra filter | Non-column search filter declared per table. (not: custom filter) |
| Extended condition | Consumer-supplied SQL fragment merged into a search WHERE. |
| Dotted notation | `orderBy`/condition key counted in parts: 1-part `field`, 2-part `alias.field`, 3-part `alias.fn.field`. (not: parti) |
| Tenant scope | Row-level isolation: `direct` (own column), `indirect` (via FK) or `anyOf`. |
| `anyOf` scope | Tenant scope over several owner columns: the row is visible to any of them. |
| Anchor | The owner column an `anyOf` write names to tie a new row to the caller. |
| Engine | Dialect-agnostic function performing one operation. (not: service, handler) |
| Route | Fastify plugin exposing an engine over HTTP. (not: controller) |
| Dialect | Per-DB SQL differences (`postgres` \| `mysql` \| `mariadb`). |
| QueryClient | Connection wrapper the engines run SQL through. (not: db, connection) |
| Paginator | Request object carrying page and items-per-page. (not: pagination, pager) |
| Manifest | Runtime description of a deployment's tables, for agent clients. |
