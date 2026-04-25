# fastify-auto-sqlapi — Frontend API Usage

How to call the auto-generated CRUD endpoints.

> ⚠️ **Migrating from a previous version?** The join API was redesigned (no backward compat). See **[BREAKING_CHANGES.md](./BREAKING_CHANGES.md)** for the full migration guide — request/response key renames, new `joinLeft` family, dotted notation rules, secondaries key renames. Common to backend and frontend.

## Generated Endpoints

The plugin defines routes with these base paths: `/search/`, `/rest/`, `/bulk/`. The prefix from `register()` is prepended by Fastify. For a table `customer` with `prefix: '/auto'`:

```
POST   /auto/search/customer           — search with filters in body
GET    /auto/rest/customer/:id         — get single record by PK
POST   /auto/rest/customer             — insert record (+ secondaries)
PUT    /auto/rest/customer             — update record (+ secondaries + deletions)
DELETE /auto/rest/customer/:id         — delete record by PK
PUT    /auto/bulk/customer             — bulk upsert (array of items)
POST   /auto/bulk/customer/delete      — bulk delete (array of PKs)
```

Without prefix, routes are at root: `/search/customer`, `/rest/customer/:id`, etc.

---

## POST /search/{tableName}

**Important**: Search uses `POST` (not GET) because filters are passed in the request body as JSON.

### Query parameters (all optional)

```
?orderBy=name ASC, id DESC
&page=1&itemsPerPage=20
&computeMin=id&computeMax=id&computeSum=total&computeAvg=total
```

- `orderBy` — SQL ORDER BY clause (default: `defaultOrder` from table config). Supports dotted notations for joins, see below.
- `page` + `itemsPerPage` — pagination (when either is present, response includes `pagination` object; `page` defaults to 1, `itemsPerPage` defaults to 500)
- `computeMin`, `computeMax`, `computeSum`, `computeAvg` — aggregate a column, returned in `pagination.computed`

### Body (all fields optional, empty `{}` returns all records)

```json
{
  "filters": { "name": "Mario", "q": "search term" },
  "conditions": [
    { "field": "createdAt", "method": "isGreater", "params": ["2024-01-01"] }
  ],
  "joinMustExist": {
    "labels": { "filters": { "labelId": 1 } }
  },
  "joinMultiple": {
    "orders": { "filters": { "status": "pending" } }
  },
  "joinGroup": {
    "orders": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "min": ["total"],
        "max": ["total"],
        "distinctCount": ["status"]
      },
      "filters": { "status": "active" }
    }
  },
  "joinLeft": {
    "creator": { "selection": "id,name,email" }
  }
}
```

The keys inside `joinMustExist`, `joinMultiple`, `joinGroup`, `joinLeft` are **aliases** declared by the backend in `buildRelation`. By default an alias equals the joined table's name; backends may override it (e.g. `'orders'` instead of `'customer_order'`) or declare multiple aliases for the same table (e.g. `'creator'` and `'updater'` both pointing to `user`). Check the Swagger description of each `/search/{table}` endpoint to see the available aliases.

### Filters

Pass any schema field as a key in `filters`. The plugin auto-applies `WHERE col = value` for each. Extra filters (defined via `extraFiltersValidation` in the table config) are also accepted but handled by custom logic.

### Conditions (advanced filters)

`conditions` allows using any ConditionBuilder method for advanced comparisons. Each condition specifies a `field`, a `method`, and `params` (values after the field).

```json
{
  "filters": { "status": "active" },
  "conditions": [
    { "field": "total", "method": "isGreater", "params": [100] },
    { "field": "total", "method": "isLess", "params": [500] },
    { "field": "name", "method": "isILike", "params": ["%mario%"] },
    { "field": "createdAt", "method": "isBetween", "params": ["2024-01-01", "2024-12-31"] },
    { "field": "status", "method": "isIn", "params": [["active", "pending"]] },
    { "field": "deletedAt", "method": "isNull", "params": [] }
  ]
}
```

**Available methods** (mapped to ConditionBuilder):

| Method | SQL | params |
|---|---|---|
| `isEqual`, `isNotEqual` | `= $1` / `!= $1` | `[value]` |
| `isGreater`, `isGreaterOrEqual` | `> $1` / `>= $1` | `[value]` |
| `isLess`, `isLessOrEqual` | `< $1` / `<= $1` | `[value]` |
| `isLike`, `isNotLike` | `LIKE $1` | `["%pattern%"]` |
| `isILike`, `isNotILike` | `ILIKE $1` | `["%pattern%"]` |
| `isIn`, `isNotIn` | `IN (...)` | `[[val1, val2]]` |
| `isBetween`, `isNotBetween` | `BETWEEN $1 AND $2` | `[from, to]` |
| `isNull`, `isNotNull` | `IS NULL` / `IS NOT NULL` | `[]` |

Also available: `isNotGreater`, `isNotGreaterOrEqual`, `isNotLess`, `isNotLessOrEqual`.

- **Multiple conditions on the same field** — it's an array, so `total > 100 AND total < 500` is natural
- **Combinable** with `filters` (equality), `joinMustExist` (EXISTS), pagination, etc.
- **Field validation** — field names are validated against the table schema (400 if unknown)
- **Method validation** — only whitelisted methods are allowed (`raw`, `append` etc. are blocked)

#### Conditions on joinGroup aggregations (HAVING-style)

You can filter main rows based on the value of a `joinGroup` aggregation using 3-parti dot notation: `<alias>.<fn>.<field>`.

Example: "users with at least 4 sessions":

```json
{
  "conditions": [
    { "field": "sessions.count.id", "method": "isGreaterOrEqual", "params": [4] }
  ],
  "joinGroup": {
    "sessions": { "aggregations": { "count": ["id"] } }
  }
}
```

Generated SQL:
```sql
SELECT * FROM "user"
WHERE COALESCE((
  SELECT COUNT("session"."id")
  FROM "session"
  WHERE "session"."user_id" = "user"."id"
), 0) >= $1
```

**Rules:**
- The joinGroup must be declared in `joinGroup.<alias>.aggregations.<fn>` with the referenced field. The engine refuses undeclared references with 400.
- The joinGroup's own `filters` are applied inside the correlated subquery (consistent with the breakdown).
- All ConditionBuilder methods work: `isEqual`, `isGreater`, `isLess`, `isBetween`, `isIn`, `isNull`, `isNotNull`, etc.
- Can be combined with plain-field conditions and with aggregation `orderBy` in the same request.
- Respects `aggregations.by` rules: allowed only when `by` equals the correlation FK, otherwise 400.

### `joinMustExist` (filter main by related table — EXISTS)

`joinMustExist` restricts **main table results** based on conditions on a related child table. Aliases must come from `allowedReadJoins` declarations with `unique: false`. Uses `EXISTS` subquery — no duplicate rows, works correctly with pagination.

```json
{
  "filters": { "name": "Mario" },
  "joinMustExist": {
    "labels": { "filters": { "labelId": 1 } }
  }
}
```

SQL generated:
```sql
SELECT * FROM "customer"
WHERE "name" = $1
  AND EXISTS (SELECT 1 FROM "customer_label_link"
    WHERE "customer_id" = "customer"."id" AND "label_id" = $2)
```

`joinMustExist` accepts `{ filters, conditions }` (both optional). Supports schema fields + extra filters defined via `extendedCondition` on the related table. Combinable with `filters`, `joinMultiple`, `joinGroup`, `joinLeft`, and pagination.

**Difference from `joinMultiple`**: `joinMustExist` filters which main records are returned. `joinMultiple` fetches related child data for the returned main records. They can be used together.

### `joinMultiple` (fetch related child rows)

Request related child table data via `joinMultiple`. Aliases must come from `allowedReadJoins` declarations with `unique: false`. Each entry accepts `{ filters?, conditions?, selection? }`.

```json
{
  "joinMultiple": {
    "orders": {
      "filters": { "status": "pending" },
      "selection": "id,total,status"
    }
  }
}
```

`selection` is optional and overrides the default declared in `buildRelation` (which itself defaults to `'*'`).

The fetch executes as a separate side query: `SELECT {selection} FROM {childTable} WHERE {fk} IN ({main PKs})`. Returned in `result.joinMultiple.<alias>` as an array.

### `joinGroup` (aggregations on related child rows)

`joinGroup` computes aggregated values on a related child table:

```json
{
  "joinGroup": {
    "orders": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "min": ["total"],
        "max": ["total"],
        "avg": ["total"],
        "count": ["id"],
        "distinctCount": ["status"]
      },
      "filters": { "status": "active" }
    }
  }
}
```

- `by` — GROUP BY field (optional)
- `sum`, `min`, `max`, `avg` — aggregate functions on specified columns
- `count` — COUNT(col)
- `distinctCount` — COUNT(DISTINCT col)
- `filters` — optional, narrow rows before aggregation

Returned as `result.joinGroup.<alias>` — keyed by the function name when no `by`, or with a `rows` array when `by` is set.

Aliases must come from `allowedReadJoins` declarations with `unique: false`.

### `joinLeft` (embed N:1 parent inline)

`joinLeft` embeds a parent record (N:1 relation) into the result. Aliases must come from `allowedReadJoins` declarations with `unique: true`. Each entry accepts `{ filters?, conditions?, selection? }`.

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
- when `orderBy` uses 2-parti dotted notation referring to a parent field (`<alias>.<field>`).

Otherwise only a side query `WHERE pk IN (distinct fk values)` is issued — no LEFT JOIN, no row duplication. Either way, the response shape is the same.

The parent rows are returned in `result.joinLeft.<alias>` as a deduplicated array. The client maps a main row to its parent by FK lookup:

```js
const parent = result.joinLeft.creator.find((u) => u.id === mainRow.userId);
```

> **Limitation**: `extraFilters` declared via `extendedCondition` on the parent table are **not** applied inside `joinLeft.filters` (only schema fields). The other join families fully support extraFilters.

### Ordering

Use the `orderBy` query parameter. Three forms are supported:

| Form | Source of `<alias>` | Example |
|------|---------------------|---------|
| `<field> [ASC\|DESC]` | main schema | `?orderBy=name ASC` |
| `<alias>.<field> [ASC\|DESC]` | `joinLeft`-eligible (`unique: true`) | `?orderBy=creator.name ASC` |
| `<alias>.<fn>.<field> [ASC\|DESC]` | `joinGroup` declared in same body | `?orderBy=orders.sum.total DESC` |

Multiple parts may be comma-separated: `?orderBy=creator.name ASC, id DESC`.

If not specified, the table's `defaultOrder` is used.

#### Ordering by joinGroup aggregations (3-parti)

Supported functions: `sum`, `min`, `max`, `avg`, `count`, `distinctCount`.

Example: get users ordered by total session duration DESC.

```
POST /auto/search/user?orderBy=sessions.sum.duration%20DESC
```
```json
{
  "joinGroup": {
    "sessions": {
      "aggregations": { "sum": ["duration"] }
    }
  }
}
```

Generated SQL (simplified):
```sql
SELECT * FROM "user"
ORDER BY (
  SELECT SUM("session"."duration")
  FROM "session"
  WHERE "session"."user_id" = "user"."id"
) DESC
```

**Rules:**
- The joinGroup **must be declared in the request body** (`joinGroup.<alias>.aggregations.<fn>` must include the field). The engine refuses undeclared references with 400.
- If the joinGroup declares `filters`, those filters are applied inside the correlated subquery — consistent with the breakdown.
- **`aggregations.by`**: allowed only when `by` is the same field used for the join correlation. Using `by` on any other column is rejected with 400.
- **Not allowed** when the main table has `distinctResults: true`. 400 error.
- Can be combined with plain-field ordering and with 2-parti `joinLeft` ordering: `?orderBy=sessions.sum.duration DESC, creator.name ASC, name`.
- The joinGroup breakdown is still returned in the response (`result.joinGroup.<alias>`) — you get both ordered main results and the aggregated summary.
- **No-data rows**: rows with no matching joined records are coalesced to `0` via `COALESCE(..., 0)`. On DESC they appear last, on ASC they appear first.

#### Ordering by parent fields (2-parti)

```
?orderBy=creator.name ASC
```

The alias must be declared with `unique: true` (so it's eligible for `joinLeft`). The engine adds a real `LEFT JOIN` on the main query to make the column orderable. Main row count is preserved (no duplication, since N:1).

### Pagination

Add `page` or `itemsPerPage` to the query string to enable pagination:

```
?page=1&itemsPerPage=20
?itemsPerPage=10          # page defaults to 1
```

When either is present, the response includes a `pagination` object with total count, total pages, and the paginator values. `page` defaults to 1, `itemsPerPage` defaults to 500.

### Computed values (aggregations on main table)

```
?computeMin=id&computeMax=id&computeSum=total&computeAvg=total
```

These compute aggregates on the main table's result set (respecting filters). Results appear in `pagination.computed`. Requires pagination to be active (`page` or `itemsPerPage` set).

### Response

```json
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "email": "m@t.it" }],
  "joinLeft": {
    "creator": [{ "id": 7, "name": "Alice", "email": "a@x.it" }]
  },
  "joinMultiple": {
    "orders": [{ "id": 10, "customerId": 1, "total": 50 }]
  },
  "joinGroup": {
    "orders": {
      "sum": { "total": 150 },
      "rows": [{ "by": "pending", "sum_total": 100 }]
    }
  },
  "pagination": {
    "total": 25,
    "pages": 3,
    "computed": { "min": { "id": 1 }, "max": { "id": 100 } },
    "paginator": { "page": 1, "itemsPerPage": 20 }
  }
}
```

`joinLeft`, `joinMultiple`, `joinGroup`, `pagination` appear ONLY if requested. A simple search returns just `{ table, main }`.

---

## GET /rest/{tableName}/:id

Returns a single record by primary key.

**Response (200):**

```json
{ "main": { "id": 1, "name": "Mario", "email": "m@t.it" } }
```

Returns 404 if not found.

---

## POST /rest/{tableName} (Insert)

**Body:**

```json
{
  "main": { "name": "Mario", "email": "m@t.it" },
  "secondaries": {
    "orders": [
      { "total": 50, "status": "pending" }
    ]
  }
}
```

- `main` — the record to insert. Omit auto-increment PKs (they are in `excludeFromCreation`).
- `secondaries` — optional. Related records to insert. Keys are **aliases** from `allowedWriteJoins`. FK fields (e.g. `customerId` in orders) are auto-filled from the inserted main record's PK.

**Response (201):** PK-only for main and secondaries.

```json
{
  "main": { "id": 1 },
  "secondaries": {
    "orders": [{ "id": 10 }]
  }
}
```

---

## PUT /rest/{tableName} (Update)

**Body:**

```json
{
  "main": { "id": 1, "name": "Mario Updated", "email": "new@t.it" },
  "secondaries": {
    "orders": [{ "total": 75, "status": "shipped" }]
  },
  "deletions": {
    "orders": [{ "id": 10 }]
  }
}
```

- `main` — MUST include the PK. Only changed fields need to be sent (partial update).
- `secondaries` — optional. New related records to insert (FK auto-filled). Keys are **aliases**.
- `deletions` — optional. Related records to delete (by PK). Keys are **aliases**.

**Response (200):** PK-only for main, secondaries, and deletions.

```json
{
  "main": { "id": 1 },
  "secondaries": { "orders": [{ "id": 20 }] },
  "deletions":   { "orders": [{ "id": 10 }] }
}
```

---

## DELETE /rest/{tableName}/:id

Deletes a single record by primary key.

**Response (200):** PK-only.

```json
{ "main": { "id": 1 } }
```

404 if not found.

---

## PUT /bulk/{tableName} (Bulk Upsert)

Insert or update multiple records in a single request.

**Body:**

```json
[
  {
    "main": { "name": "Mario", "email": "m@t.it" },
    "secondaries": { "orders": [{ "total": 50 }] },
    "deletions": { "orders": [{ "id": 99 }] }
  },
  {
    "main": { "name": "Luigi", "email": "l@t.it" }
  }
]
```

All main records are inserted/upserted in a single SQL query. Secondaries and deletions are processed per-item. `secondaries`/`deletions` keys are **aliases**.

**Response (200):** Array of `{ main (PK-only), secondaries? (PK-only), deletions? }`.

---

## POST /bulk/{tableName}/delete (Bulk Delete)

Delete multiple records by PK.

**Body:**

```json
[{ "id": 1 }, { "id": 2 }, { "id": 3 }]
```

Each object must contain the PK field. All deletions execute as a single `DELETE WHERE pk IN (...)`.

**Response (200):** Array of PK-only objects.

```json
[{ "main": { "id": 1 } }, { "main": { "id": 2 } }]
```

---

## Validation Errors

Insert, update, and bulk-upsert endpoints may return **structured field-level validation errors** (400). Two sources:

1. **Schema validation** (TypeBox/Ajv) — type mismatches, missing required fields
2. **Custom validation** (`validate` / `validateBulk` on the table) — business rules, cross-entity checks

Both return the same response format:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "fields": [
    { "path": "body.main.name", "code": "required", "message": "must have required property 'name'" },
    { "path": "periods[1].startDate", "code": "overlap", "message": "overlaps with another period" }
  ]
}
```

Each entry in `fields`:
- `path` — the field path (e.g. `body.main.name` for schema errors, `name` or `periods[1].startDate` for custom validation)
- `code` — machine-readable error code (e.g. `required`, `type`, `overlap`, `unique`)
- `message` — human-readable description

### Handling validation errors in the frontend

```typescript
const response = await fetch('/api/rest/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ main: { name: '' }, secondaries: { periods } }),
});

if (!response.ok) {
  const error = await response.json();
  if (error.fields) {
    // Field-level errors — display inline on the form
    for (const { path, message } of error.fields) {
      setFieldError(path, message);
    }
  }
}
```

---

## Response Conventions

- **PK-only responses**: Insert, update, delete, bulk operations return only the primary key fields, not the full record. This is by design for performance and consistency.
- **camelCase fields**: All request and response fields use camelCase (e.g. `customerId`, not `customer_id`). The plugin converts automatically.
- **Aliases everywhere**: in request bodies, response payloads, `secondaries`/`deletions`, and dotted notation, the keys are aliases declared by the backend in `buildRelation`. Default = the joined table's name; can be overridden (e.g. `orders` for `customer_order`).
- **`joinMultiple` / `joinMustExist` / `joinGroup`** are 1:N (child→main) and use side queries / EXISTS / correlated subqueries — no row duplication of main.
- **`joinLeft`** is N:1 (parent→main) and adds a real `LEFT JOIN` on demand (only when filtering/ordering by parent).
