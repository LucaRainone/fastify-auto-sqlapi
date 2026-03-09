# fastify-auto-sqlapi — Frontend API Usage

How to call the auto-generated CRUD endpoints.

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

- `orderBy` — SQL ORDER BY clause (default: `defaultOrder` from table config)
- `page` + `itemsPerPage` — pagination (when either is present, response includes `pagination` object; `page` defaults to 1, `itemsPerPage` defaults to 500)
- `computeMin`, `computeMax`, `computeSum`, `computeAvg` — aggregate a column, returned in `pagination.computed`

### Body (all fields optional, empty `{}` returns all records)

```json
{
  "filters": { "name": "Mario", "q": "search term" },
  "joinFilters": {
    "customer_label_link": { "labelId": 1 }
  },
  "joins": {
    "customer_order": { "filters": { "status": "pending" } }
  },
  "joinGroups": {
    "customer_order": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "min": ["total"],
        "max": ["total"],
        "distinctCount": ["status"]
      },
      "filters": { "status": "active" }
    }
  }
}
```

### Filters

Pass any schema field as a key in `filters`. The plugin auto-applies `WHERE col = value` for each. Extra filters (defined via `extraFiltersValidation` in the table config) are also accepted but handled by custom logic.

### Join Filters (filter main by related table)

`joinFilters` restrict **main table results** based on conditions on a related table. Only tables listed in `allowedReadJoins` are available. Uses `EXISTS` subquery — no duplicate rows, works correctly with pagination.

```json
{
  "filters": { "name": "Mario" },
  "joinFilters": {
    "customer_label_link": { "labelId": 1 }
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

`joinFilters` support the same filter fields as the related table (schema fields + extra filters defined via `extendedCondition`). Can be combined with `filters`, `joins`, `joinGroups`, and pagination.

**Key difference from `joins`**: `joinFilters` filter which main records are returned. `joins` fetch related data for the returned main records. They can be used together.

### Joins

Request related table data via `joins`. Only tables listed in `allowedReadJoins` are available. Each join key is the table name, with optional `filters` to narrow the joined results.

The join executes as a separate query: `SELECT ... FROM {joinTable} WHERE {fk} IN ({main PKs})`. Results are grouped by FK.

### Join Groups (Aggregations)

`joinGroups` compute aggregated data on related tables:

```json
{
  "joinGroups": {
    "customer_order": {
      "aggregations": {
        "by": "status",
        "sum": ["total"],
        "min": ["total"],
        "max": ["total"],
        "distinctCount": ["status"]
      },
      "filters": { "status": "active" }
    }
  }
}
```

- `by` — GROUP BY field
- `sum`, `min`, `max` — aggregate functions on specified columns
- `distinctCount` — COUNT(DISTINCT col)
- `filters` — optional, narrow rows before aggregation

### Ordering

Use the `orderBy` query parameter:

```
?orderBy=name ASC
?orderBy=name ASC, id DESC
?orderBy=created_at DESC
```

If not specified, the table's `defaultOrder` is used.

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
  "joins": {
    "customer_order": [{ "id": 10, "customerId": 1, "total": 50 }]
  },
  "joinGroups": {
    "customer_order": {
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

`joins`, `joinGroups`, `pagination` appear ONLY if requested. A simple search returns just `{ table, main }`.

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
    "customer_order": [
      { "total": 50, "status": "pending" }
    ]
  }
}
```

- `main` — the record to insert. Omit auto-increment PKs (they are in `excludeFromCreation`).
- `secondaries` — optional. Related records to insert. Only tables in `allowedWriteJoins` are accepted. FK fields (e.g. `customerId` in orders) are auto-filled from the inserted main record's PK.

**Response (201):** PK-only for main and secondaries.

```json
{
  "main": { "id": 1 },
  "secondaries": {
    "customer_order": [{ "id": 10 }]
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
    "customer_order": [{ "total": 75, "status": "shipped" }]
  },
  "deletions": {
    "customer_order": [{ "id": 10 }]
  }
}
```

- `main` — MUST include the PK. Only changed fields need to be sent (partial update).
- `secondaries` — optional. New related records to insert (FK auto-filled).
- `deletions` — optional. Related records to delete (by PK).

**Response (200):** PK-only for main, secondaries, and deletions.

```json
{
  "main": { "id": 1 },
  "secondaries": { "customer_order": [{ "id": 20 }] },
  "deletions": { "customer_order": [{ "id": 10 }] }
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
    "secondaries": { "customer_order": [{ "total": 50 }] },
    "deletions": { "customer_order": [{ "id": 99 }] }
  },
  {
    "main": { "name": "Luigi", "email": "l@t.it" }
  }
]
```

All main records are inserted/upserted in a single SQL query. Secondaries and deletions are processed per-item.

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

## Response Conventions

- **PK-only responses**: Insert, update, delete, bulk operations return only the primary key fields, not the full record. This is by design for performance and consistency.
- **camelCase fields**: All request and response fields use camelCase (e.g. `customerId`, not `customer_id`). The plugin converts automatically.
- **Joins are virtual**: Not SQL JOINs. They execute separate queries and group results by FK. This keeps the main query simple and avoids N+1 issues through batching.
