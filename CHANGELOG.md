# Changelog

All notable changes to this project are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to
[Semantic Versioning](https://semver.org/) — with the caveat that while the version is
`0.x`, breaking changes may land in a minor release.

Migration instructions for breaking changes live in **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)**.

## [0.1.10]

### Added

- **Architecture Decision Records** in `docs/adr/` (shipped in the npm package so agents
  consuming the library can read them): no-ORM/raw-SQL, open-by-default, non-transactional
  bulk operations, always-updatable fields (no `excludeFromUpdate`), insert-pipeline
  ordering, raw DB errors. Linked from README ("Design Decisions") and AGENTS.md.

### Fixed

- **`excludeFromCreation` no longer strips values set by `beforeInsert`.** The exclusion list
  was applied after the hook, so a server-generated value assigned in `beforeInsert` (the
  documented pattern for TEXT primary keys, `createdAt`, audit columns) was silently removed
  from the INSERT — a table with `excludeFromCreation: ['id']` and an id-generating hook
  failed with a not-null violation. The client payload is now sanitized *before* the hook
  runs, in both the single insert and the bulk upsert path: client-supplied values on
  excluded fields are still ignored, hook-assigned ones reach the SQL. For the same reason,
  secondary records now drop excluded fields *before* the engine's FK auto-fill, so listing
  the FK column in a secondary table's `excludeFromCreation` no longer erases the injected
  parent key.

### Documentation

- Clarified that `excludeFromCreation` is an ergonomics tool for creation, not a field-level
  security mechanism: it deliberately does not apply to updates, where every Schema field is
  writable by default. Field-level update rules (sensitive flags, roles, ownership/tenant
  columns) are product logic to enforce via `beforeUpdate`/`validate` or dedicated endpoints —
  see the new "Field-level update rules" section in the README and the matching pattern in
  AGENTS_BACKEND.md.

## [0.1.7]

### Fixed

- **Ambiguous column references in statements carrying a join.** A filtered `joinLeft` adds a
  `LEFT JOIN` to the main query, and a tenant scope with `through` adds an `INNER JOIN`. Any
  column name shared with the joined table (`id`, `name` — the common case) was ambiguous:
  PostgreSQL rejected the statement, and a reference could otherwise resolve against the wrong
  table. Every column reference is now table- or alias-qualified: filters, conditions, computed
  expressions, `orderBy`, join selections, aggregations and tenant conditions.
- **Correlated subqueries broke on self-referencing relations.** `joinMustExist` emitted
  `EXISTS (SELECT 1 FROM "t" WHERE "t"."fk" = "t"."id")` when a relation pointed back at its own
  table; the inner name shadowed the outer one, so the correlation was lost and the filter
  silently matched the wrong rows. The subquery source is now aliased.

### Changed

- Placeholder offsets are owned by a single accumulator (`QueryParams`) instead of being
  recomputed at each call site. No behaviour change; it removes the class of mistake where a
  fragment's placeholders drift out of step with the values array.

### Testing

- Unit tests now assert two invariants on **every** query the engine generates: placeholder
  integrity (no placeholder referencing an unbound value, no bound value left unreferenced)
  and column qualification in join-bearing statements. Both are enforced by the shared mock
  driver, so they apply to the whole suite rather than to hand-written assertions.
- New integration suite executes ~45 request shapes — all four join families, computed fields
  with and without bound values, every `orderBy` form, pagination, aggregations — against real
  PostgreSQL and MySQL, so a syntax error fails a test instead of reaching a consumer.

## [0.1.6]

### Fixed

- **⚠️ Computed fields with bound values silently returned wrong rows.** A computed field
  declaring `values` could not know its own placeholder offset, so its expression referenced
  whichever parameter another filter happened to bind. The query did not fail — it filtered or
  sorted on the wrong value. If you use `computedFields` with a non-empty `values` array,
  **results produced by 0.1.5 and earlier may be incorrect.**

### Breaking

- `ComputedFieldExpr.expr` now marks each bound value with `?`; the engine assigns placeholder
  positions. Writing `$1` or `db.ph(n)` inside the expression is rejected with a descriptive
  error. Computed fields that declare **no** bound values are unaffected — the majority case
  (JSON extraction, `CONCAT`, `dateTrunc`, arithmetic) needs no change, and a literal `?` such
  as the PostgreSQL jsonb operator keeps working.
  See [BREAKING_CHANGES.md](./BREAKING_CHANGES.md#breaking-change--computed-field-placeholders-use--markers).

### Added

- Bound values in computed fields now work in every position that lands in the `WHERE` clause
  or in `ORDER BY`, including `joinLeft.filters`, `joinLeft.conditions` and `orderBy`, which
  previously rejected them with 400. They remain rejected in `selectComputed`,
  `computeMin/Max/Sum/Avg`, `joinGroup.aggregations.by` and `defaultOrder`, where the
  expression precedes the `WHERE` values in the parameter order.
- A computed field whose `?` markers do not match `values.length` now fails with a clear error
  instead of producing a query that binds values nothing references.

## [0.1.5]

### Added

- **`readExclude`** on `defineTable`: hide columns from every read while leaving writes
  untouched — the case for a password hash or an access token, writable but never readable.
  Excluded fields are not selected by search/get, are omitted from read response schemas and
  from the table's default join selection, and cannot be referenced from `filters`,
  `conditions`, `orderBy`, aggregations or an explicit join `selection` (400). Allowing a
  hidden field to be filtered would leak its value by bisection. Primary keys cannot be
  excluded.

### Fixed

- **Granular route plugins did not work standalone.** Registering only `searchRoutes`/`getRoutes`
  as documented produced a 500, because `fastify.sqlApi` was decorated by the main plugin alone.
  Each route plugin now creates the decorator in its own scope when no ancestor provides it.
- **`defaultOrder` required raw column names** while the rest of the API is camelCase, so
  `defaultOrder: 'squadIndex'` produced `column "squadindex" does not exist`. It is now mapped
  through the schema like the request `orderBy`, and supports multiple fields and computed
  fields. Raw SQL fragments still pass through unchanged, so existing configurations keep
  working. The same mapping applies to the primary-key fallback, which had the same defect.
- **`sqlapi-generate-tables` with a subset of tables** generated a `dbTables.ts` importing every
  schema, including tables whose `Table*.ts` was never created — the project did not compile
  until the file was trimmed by hand. The index now references only the table files present on
  disk, and the CLI reports which entries to add when `dbTables.ts` already exists.
- **Generated imports lacked the `.js` extension**, so the emitted files did not compile under
  `moduleResolution: NodeNext` without editing them by hand.

## [0.1.4]

### Fixed

- Hardened tenant isolation, added request limits (`maxItemsPerPage`, `maxBulkItems`), and
  fixed placeholder binding in search.

## [0.1.3] and earlier

Released before this changelog was kept. See the git history for details: notable entries are
the join API redesign (documented in [BREAKING_CHANGES.md](./BREAKING_CHANGES.md)), composite
primary key support in updates, transactional insert/update with secondaries, the hook matrix,
and bulk operations.

[0.1.7]: https://github.com/LucaRainone/fastify-auto-sqlapi/releases/tag/v0.1.7
[0.1.6]: https://github.com/LucaRainone/fastify-auto-sqlapi/releases/tag/v0.1.6
[0.1.5]: https://github.com/LucaRainone/fastify-auto-sqlapi/releases/tag/v0.1.5
[0.1.4]: https://github.com/LucaRainone/fastify-auto-sqlapi/releases/tag/v0.1.4
