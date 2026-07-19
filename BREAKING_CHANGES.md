# Breaking Changes — Join API redesign

The join API was rewritten to be explicit, alias-based, and to add a real `LEFT JOIN` mode (`joinLeft`) for N:1 relationships. **No backward compatibility** — old names are rejected with 400. Both backend (table configuration) and frontend (request/response shapes) are affected. This document is the single source of truth for migrating either side.

## Why this changed

- The old API conflated "filter by child", "fetch children", and "aggregate children" under generic names (`joinFilters`, `joins`, `joinGroups`).
- There was no way to embed a parent record (N:1) inline in the search results, nor to order/filter the main query by a parent field.
- The same table could not be joined twice with different semantic roles (e.g. `createdBy` and `updatedBy` both pointing to `user`) because lookup keys collided on `joinSchema.tableName`.

The new API addresses all three with a coherent `join*` prefix family and explicit `alias`.

## Naming map

| Old (request body) | New (request body) | Direction | Cardinality | What it does |
|--------------------|--------------------|-----------|-------------|--------------|
| `joinFilters` | `joinMustExist` | child → main | 1:N | Filters main rows via `EXISTS` subquery |
| `joins` | `joinMultiple` | child → main | 1:N | Fetches child rows in a side query |
| `joinGroups` | `joinGroup` | child → main | 1:N | Aggregations on children (SUM/MIN/…) with optional GROUP BY |
| — | `joinLeft` | parent → main | N:1 | **NEW** real `LEFT JOIN` for embedding the parent |

| Old (response) | New (response) |
|----------------|----------------|
| `result.joins` | `result.joinMultiple` |
| `result.joinGroups` | `result.joinGroup` |
| — | `result.joinLeft` (NEW) |

| Old (`buildRelation` last arg) | New (`buildRelation` last arg) |
|---------------------------------|---------------------------------|
| `selection?: string` (positional) | `options?: { alias?: string; selection?: string; unique?: boolean }` (all optional; `alias` defaults to `joinSchema.tableName`) |

| Old (lookup key inside the body) | New (lookup key inside the body) |
|-----------------------------------|-----------------------------------|
| `joinSchema.tableName` | `alias` (declared in `buildRelation`) |

The `alias` is also the key used in:
- Response payloads (`result.joinMultiple.<alias>`, `result.joinLeft.<alias>`, `result.joinGroup.<alias>`)
- `secondaries` and `deletions` payloads in insert/update/bulk-upsert (`secondaries: { <alias>: [...] }`)
- Dotted notation in `orderBy` and `conditions`

## buildRelation — new signature

```typescript
// Options object is optional; every field has a sensible default.
buildRelation(mainSchema, mainField, joinSchema, joinField);

// Or with any subset of options:
buildRelation(mainSchema, mainField, joinSchema, joinField, {
  alias: 'creator',         // optional, default = joinSchema.tableName.
                            // Used as the key in request/response/secondaries payloads
                            // and in dotted-notation orderBy/conditions.
  selection: '*',           // optional, default '*'. Comma-separated list, e.g. 'id,name,email'.
  unique: false,            // optional, default false.
                            //   true  → relation is N:1 (each main row has at most one join row).
                            //           Allowed in joinLeft. Forbidden in joinMultiple/joinMustExist/joinGroup.
                            //   false → relation is 1:N. Allowed in the other three. Forbidden in joinLeft.
});
```

You only need to declare an explicit `alias` when:
- you join the same table more than once (e.g. `createdBy` and `updatedBy` both pointing to `user`); or
- you want a name different from the join table's name in the API surface (e.g. `'orders'` instead of `'customer_order'`).

If two relations within the same `allowedReadJoins` (or `allowedWriteJoins`) end up resolving to the same alias — explicit or implicit — `defineTable` throws at startup with:

```
defineTable: duplicate alias '<name>' in allowedReadJoins. When omitted,
alias defaults to joinSchema.tableName — declare an explicit alias to disambiguate.
```

If a request hits an alias on the wrong family, the engine returns `400`:

```
Join alias 'orders' is not declared with unique:true; use joinMultiple/joinMustExist/joinGroup instead
Join alias 'creator' is declared with unique:true; use joinLeft instead
Unknown join alias: <name>
```

## Request body — by family

### `joinMustExist` (was `joinFilters`)

EXISTS-based filter: returns main rows that have at least one matching child.

```json
{
  "joinMustExist": {
    "orders": {
      "filters": { "status": "completed" },
      "conditions": [{ "field": "total", "method": "isGreater", "params": [50] }]
    }
  }
}
```

### `joinMultiple` (was `joins`)

Fetches child rows in a side query; populates `result.joinMultiple.<alias>`.

```json
{
  "joinMultiple": {
    "orders": {
      "filters": { "status": "completed" },
      "selection": "id,total,status"
    }
  }
}
```

`selection` is optional and overrides the default declared in `buildRelation`.

### `joinGroup` (was `joinGroups`)

Aggregations on the child table; populates `result.joinGroup.<alias>`.

```json
{
  "joinGroup": {
    "orders": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "count": ["id"]
      },
      "filters": { "status": "completed" }
    }
  }
}
```

### `joinLeft` (NEW, requires `unique: true`)

Real `LEFT JOIN` for N:1 (parent) relationships. The parent rows are returned in `result.joinLeft.<alias>` as a deduplicated array (one entry per distinct parent PK).

```json
{
  "joinLeft": {
    "creator": {},
    "updater": { "filters": { "active": true }, "selection": "id,name" }
  }
}
```

The engine attaches a real `LEFT JOIN <parentTable> AS <alias>` to the main query **only when needed**:
- when the request includes `filters` or `conditions` on the parent (effectively turns into INNER JOIN behavior on those aliases — main rows whose parent doesn't match are excluded);
- when `orderBy` uses 2-parti dotted notation referring to a parent field (`alias.field`).

Otherwise only a side query `WHERE pk IN (distinct fk values)` is issued — no LEFT JOIN, no row duplication. Either way, the response shape is the same.

> **Limitation**: `extraFilters` declared via `extendedCondition` on the parent table are **not** applied inside `joinLeft.filters` (only schema fields). The other join families fully support extraFilters.

## orderBy — dotted notations

| Form | Allowed alias source | What it does |
|------|----------------------|--------------|
| `<field>` | main schema | regular column ordering |
| `<alias>.<field>` | `joinLeft` (`unique: true` aliases) | orders main query by a parent field via LEFT JOIN |
| `<alias>.<fn>.<field>` | `joinGroup` (declared in the same body) | orders main query by an aggregation via correlated scalar subquery |

Ambiguity: 2-parti and 3-parti are disambiguated by counting dots. The 2-parti is rejected unless the alias is in `joinLeft` allowlist; 3-parti is rejected unless the alias is in the request `joinGroup` declaration.

## Response shape

```json
{
  "table": "session",
  "main": [...],
  "joinLeft":     { "creator": [...], "updater": [...] },
  "joinMultiple": { "orders": [...] },
  "joinGroup":    { "orders": { "sum": { "total": 300 }, "count": { "id": 2 } } },
  "pagination":   { "total": 25, "pages": 3, "paginator": { "page": 1, "itemsPerPage": 20 } }
}
```

All four `join*` keys appear only when requested. `pagination` only when `paginator` is provided.

Each value in `result.joinLeft.<alias>` is an array of parent rows (one entry per distinct FK in `main`). The client maps a main row to its parent by FK lookup (`main.userId === joinLeft.creator[i].id`).

## Write side — secondaries / deletions

`secondaries` and `deletions` payloads in insert/update/bulk-upsert now use the **alias** as key (was `joinSchema.tableName`):

```json
{
  "main": { "name": "Mario" },
  "secondaries": { "orders": [{ "total": 50 }] },
  "deletions":   { "orders": [{ "id": 10 }] }
}
```

## Migration recipes (mechanical)

### 1) Find every `buildRelation` call

Old form:
```
buildRelation(M, mF, J, jF)
buildRelation(M, mF, J, jF, '<sel>')        // 5th positional arg = selection
```

New form (alias is optional, defaults to `J.tableName`):
```ts
// Simplest case — no rewrite needed beyond removing the old positional selection:
buildRelation(M, mF, J, jF)

// Or supply any options you actually need:
buildRelation(M, mF, J, jF, {
  // alias: 'orders',          // omit if joinSchema.tableName is fine as alias
  // selection: 'id, total',   // omit for '*'
  // unique: true              // ADD if jF is the PK of J (relation is N:1)
})
```

**Heuristic for `unique`**: if `joinField` is the PK (or part of the composite PK) of `joinSchema`, the relation is N:1 and you almost certainly want `unique: true` so the alias is usable in `joinLeft`. Mark the call with a `// TODO verify unique:true` and review.

**When to add an explicit `alias`**: only if (a) you join the same table multiple times, or (b) you want a friendlier name than the SQL table name (e.g. `orders` vs `customer_order`).

### 2) Rename request keys (regex-replace inside HTTP/JSON bodies and search params)

```
joinFilters: → joinMustExist:
joins:       → joinMultiple:
joinGroups:  → joinGroup:
```

### 3) Rename response accessors

```
result.joins      → result.joinMultiple
result.joinGroups → result.joinGroup
body.joins        → body.joinMultiple
body.joinGroups   → body.joinGroup
```

(Plus `result.joinLeft` is now available for the new family.)

### 4) Rename secondaries keys

If you used the join table's name as the secondaries key, change it to the new alias:

```diff
- "secondaries": { "customer_order": [...] }
+ "secondaries": { "orders": [...] }
```

### 5) Inspect dotted orderBy/conditions

`<table>.<fn>.<field>` still works for joinGroup, but `<table>` must now be the alias declared in `buildRelation`. If the alias differs from the old `tableName`, update the string.

If you need to order by a parent field, **add a `joinLeft`-eligible relation** (with `unique: true`) and use 2-parti notation `alias.field` (NEW capability — not available before).

## Validation summary (400 responses)

The engine rejects, with `statusCode: 400`, any of:

- `joinLeft` referencing an alias declared with `unique: false`
- `joinMultiple`/`joinMustExist`/`joinGroup` referencing an alias declared with `unique: true`
- request keys referencing an alias not declared in `allowedReadJoins`
- `orderBy` 2-parti `<alias>.<field>` whose alias is not in `joinLeft`-eligible (i.e. `unique:true`) declarations
- `orderBy` 3-parti `<alias>.<fn>.<field>` whose alias or `(fn, field)` pair is not declared in `joinGroup` for the same request
- `defineTable` with two `allowedReadJoins`/`allowedWriteJoins` entries resolving to the same alias (thrown at startup, not at request time)

---

# Breaking Change — computed field placeholders use `?` markers

`ComputedFieldExpr.expr` must now mark each bound value with `?`. The engine assigns the
placeholder positions. Writing `$1` (or `db.ph(n)`) inside the expression no longer works and
is rejected with a descriptive error.

## Why this changed

A computed field cannot know its own placeholder offset: the position depends on how many
values the rest of the query bound before it. The previous contract asked the *consumer* to
supply "stable indices", which is not knowable — so any computed that declared `values` and
was used together with another filter produced a query that referenced the wrong parameter:

```
WHERE ("name" = $1) AND (CASE WHEN "role" = $1 THEN ... END = $3)
values: ['Mario', 'admin', 500]
```

`$2` ('admin') was bound but never referenced, while the expression read `$1` ('Mario'). The
query did not fail — it silently returned the wrong rows.

## Migration

```typescript
// Before — placeholder guessed by the caller (silently misbound)
bonus: ({ db, qiCol }) => ({
  expr: `CASE WHEN ${qiCol('role')} = ${db.ph(1)} THEN ${qiCol('salary')} ELSE 0 END`,
  values: ['admin'],
  type: Type.Number(),
}),

// After — `?` marker, position assigned by the engine
bonus: ({ qiCol }) => ({
  expr: `CASE WHEN ${qiCol('role')} = ? THEN ${qiCol('salary')} ELSE 0 END`,
  values: ['admin'],
  type: Type.Number(),
}),
```

Computed fields that declare **no** bound values (the majority: JSON extraction, concat,
`dateTrunc`, arithmetic) are unaffected and need no change. Their SQL is emitted verbatim, so
a literal `?` — the PostgreSQL jsonb operator — keeps working. In an expression that *does*
carry values, escape a literal question mark as `\?`.

A mismatch between the number of `?` markers and `values.length` now raises a descriptive
error instead of producing a wrong query.

## What this unlocks

Bound values now work in every position that lands in the `WHERE` clause or in `ORDER BY`,
including `joinLeft.filters` / `joinLeft.conditions` and `orderBy`, which previously rejected
them with 400. They remain rejected in `selectComputed`, `computeMin/Max/Sum/Avg`,
`joinGroup.aggregations.by` and `defaultOrder`, where the expression precedes the `WHERE`
values in the parameter order.
