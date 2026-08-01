# Changelog

All notable changes to this project are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to
[Semantic Versioning](https://semver.org/) — with the caveat that while the version is
`0.x`, breaking changes may land in a minor release.

Migration instructions for breaking changes live in **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)**.

## [Unreleased]

### Changed

- **Unknown `filters` keys are now rejected with `400 Unknown filter field: <key>`** instead
  of being dropped in silence — on the main table and on every join family. The engine only
  ever visited keys matching a schema field, an `extraFilters` entry or a computed field, so a
  mistyped filter name came back as an unfiltered (wider) result set with no error: the
  dangerous direction to fail in, and inconsistent with `selection`, `conditions`, `orderBy`
  and aggregations, which have always answered 400. The check lives in the engine, so it
  covers `sqlApi.search()` as well as the HTTP routes. `undefined` values still mean "filter
  not supplied" and are ignored; an explicit `null` still filters by `IS NULL`. See
  [BREAKING_CHANGES.md](./BREAKING_CHANGES.md#breaking-change--unknown-filter-keys-are-rejected).
- **`joinLeft.<alias>.filters` no longer advertises the parent's `extraFilters`.** They were
  present in the generated body schema and in Swagger, but `buildLeftJoinClauses` never runs
  the target's `extendedCondition` (its column references cannot be qualified with the
  `LEFT JOIN` alias), so the filter applied nothing. They are now rejected with a `400` naming
  the reason and pointing at `joinMustExist` on the same relation.

### Fixed

- **Join validation no longer depends on the main result set.** `joinMultiple` / `joinLeft` /
  `joinGroup` skip their side query entirely when the main query matched no rows, so everything
  validated inside it was skipped with it — the same request answered 400 or 200 depending on
  the data. This covered filter keys and `readExclude` on join filters, an explicit `selection`
  naming an unknown field, and `joinGroup` aggregation fields including `aggregations.by`. Join
  filters are now validated up front, and the selection and aggregation lists are resolved
  before the empty-result bail-out.

### Added

- **`fields` allowlist on `buildRelation`** — restricts which of the target table's fields are
  reachable through one relation, without hiding them from the table's own routes the way
  `readExclude` would. The relation is declared against a schema narrowed to the list, so
  `selection`, `filters`, `conditions`, `orderBy`, aggregations and the generated
  request/response schemas all reject anything outside it with `400 Unknown field`; the default
  `'*'` selection is spelled out into the allowed columns instead of emitting a real `SELECT *`;
  and computed fields on the target resolve against the narrowed schema, so one reading an
  excluded column is a 400 rather than a way around the list. Declaration-time checks: the list
  must include the join field, and is rejected on `allowedWriteJoins` (write paths resolve
  `upsertMap` by schema identity and must write every column the caller sent). Fail-closed by
  design — see [ADR 0011](./docs/adr/0011-join-fields-allowlist.md) for allowlist vs blocklist.
- **[ADR 0010](./docs/adr/0010-joins-do-not-run-route-guards.md)** — a declared join is a read
  grant: `onRequests` and `operations` are route-level and do not follow a join, so
  `allowedReadJoins` grants read access to the target table under the *host* table's
  authorization. Documents what does cross a join (`readExclude`, `tenantScope`, the relation's
  schema), the trimmed-schema + explicit-`selection` pattern for column-level narrowing, and
  the rejected alternatives (`canBeJoined` hook, `selection` as a ceiling).

- **`excludeTables` config option** — blacklist for `sqlapi-generate-schema`. Tables
  listed in `excludeTables` in `sqlapi.config.ts` (exact names or `*` globs, e.g.
  `knex_*`) are skipped during schema generation; their previously generated schema files
  are removed as orphans on the next full run, like those of dropped tables (ADR 0009).
  Does not apply to `sqlapi-generate-tables`, which is already explicit (ADR 0007).

## [0.1.12]

### Fixed

- **Security: `aggregations.by` bypassed `readExclude`.** Every other reference to a
  read-excluded field (filters, conditions, orderBy, aggregation fields, join selections)
  is rejected with 400, but the `joinGroup` GROUP BY field was resolved without the check —
  `aggregations: { by: '<excludedField>', count: [...] }` returned the hidden field's
  distinct values verbatim in `rows[].by`. The field now goes through the same
  `validateSchemaField` guard as aggregation fields (400).
- **Security: HAVING-style conditions and 3-part aggregation `orderBy` could probe
  read-excluded fields.** `buildAggOrderExpr` validated the aggregation field without the
  join table's config, skipping the `readExclude` check. The downstream validation in the
  joinGroup execution masked it — except when the main result set was empty, where that
  validation is skipped entirely: a condition like `player.sum.<hiddenField> > X` answered
  400 when at least one row matched and 200 when none did, a binary oracle allowing
  bisection of the hidden field's aggregates. The check now fires at condition-build time.
  Found by a full audit of every field-referencing input against `readExclude` (all other
  paths verified guarded: filters, conditions, orderBy 1/2-part, selections, aggregation
  fields, compute*, GET).

### Added

- ADR 0008: agent client interface — static grammar (`AGENTS_FRONTEND.md`, same filename by
  design) + runtime manifest split, density as a feature, loose validation with the
  structured 400 as the default tool strategy.

## [0.1.11]

### Breaking

- **⚠️ By-single-id operations are disabled for composite-PK tables.** `GET /rest/:id`,
  `DELETE /rest/:id` and `POST /bulk/:table/delete` matched on the **first** PK column alone:
  on a table with `primary: ['agentId', 'teamId']`, `DELETE /rest/t/1` deleted **every** row
  with `agentId = 1`, not one record. These routes are no longer registered for composite-PK
  tables (404); explicitly listing one of them in `operations` now throws at startup, and the
  programmatic `sqlApi.get/delete/bulkDelete` reject with 400. Search, insert, update and
  bulk upsert are unaffected — they already handled every PK column. If your composite table's
  first PK column happens to be unique, these endpoints previously worked for you and are now
  gone — see
  [BREAKING_CHANGES.md](./BREAKING_CHANGES.md#breaking-change--by-single-id-operations-disabled-for-composite-primary-keys)
  for the migration paths.

### Fixed

- **⚠️ NULL values were serialized as `0` / `""` in read responses.** The generator mapped
  nullable columns to `Type.Optional(T)`, which means "key may be absent" — not "value may
  be null" — so fast-json-stringify coerced every NULL to the type's zero value (a NULL FK
  was served as `0`). Nullable columns are now generated as `Type.Optional(Nullable(T))`,
  where the new exported `Nullable()` helper emits the JSON-Schema type-array form
  (`type: ['integer', 'null']`). **Regenerate your schemas** (`sqlapi-generate-schema`) to
  pick up the fix. Note: the type-array form is deliberate — a `Type.Union([T, Type.Null()])`
  would NOT fix it, because Fastify's default Ajv `coerceTypes` corrupts values through
  union branches (`null` → `0` with the Null branch last, `0`/`""` → `null` with it first);
  with a type array no coercion happens. As a side effect, writes now accept an explicit
  `null` to set a column to NULL.
- **`maxItemsPerPage` below 500 broke every request without an explicit `itemsPerPage`.**
  The search querystring schema declared a fixed `default: 500`; Ajv injects defaults before
  the cap check runs, so any lower cap rejected the injected default with 400. The schema is
  now parameterized: `default = min(500, maxItemsPerPage)` and the cap doubles as the schema
  `maximum` (structured 400 instead of a plain error). The `SearchTableQuery(cap)` builder is
  exported; `SearchTableQueryString` remains as the default-cap variant.

### Changed

- **`filters` with an explicit `null` now filter by `IS NULL`.** Previously a null filter
  was silently dropped — a request asking "field is null" returned unfiltered results. An
  explicit `null` on a schema field now builds `WHERE col IS NULL` (undefined/absent keys
  are still ignored). `conditions` + `isNull` keeps working as before.

### Added

- **LLM / agent client support.** The plugin doubles as the enforcement layer for a chat
  agent operating on your data (tenant scoping, `readExclude`, `operations`, caps apply to
  whatever the model invents). New pieces:
  - `AGENTS_FRONTEND.md` rewritten as a compact LLM-oriented request grammar (search with
    all join families, ordering, pagination, writes, error shapes) — usable both by coding
    agents and as the system prompt of a runtime agent client. Same filename and package
    path as before, so existing references keep working; the verbose tutorial-style
    content it replaces is fully covered by the grammar plus Swagger.
  - `agentManifest: true` plugin option → `GET {prefix}/agent/manifest` (JSON) and
    `/agent/manifest.md` (markdown for the system prompt): per-table fields with
    type/required/nullable, enabled operations, join aliases with direction, computed
    fields, extra filters — always in sync with the running config, behind the same
    global `onRequests`. Also exported programmatically (`buildAgentManifest`,
    `renderAgentManifestMd`) and as a granular route plugin (`agentManifestRoutes`).
  - `agentToolSchemas(dbTables, table)` — the exact JSON Schemas the routes validate
    with, per enabled operation, for strict provider-side tool definitions.
  - README "LLM / agent clients" section and AGENTS_BACKEND.md pattern: read-only agent
    surface via granular composition, loose-tool + structured-400 retry loop vs strict
    tools.
- `Nullable(schema)` export: marks a TypeBox schema nullable via the JSON-Schema type-array
  form — the only representation safe under Fastify's default Ajv/fast-json-stringify on
  both input validation and response serialization.
- ADR 0007: table generation is explicit — `--all` is a migration helper, not the default.

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
