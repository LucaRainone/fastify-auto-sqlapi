# fastify-auto-sqlapi — client API (LLM reference)

This is the request GRAMMAR. The vocabulary (this deployment's tables, fields, join aliases, computed fields, extra filters) comes from `GET {p}/agent/manifest.md` when enabled, or from Swagger.

- All request/response fields are camelCase schema field names; the server maps them to columns.
- `{p}` = deployment prefix (e.g. `/api`). `{table}` = the table's key in the manifest, which may differ from the DB table name (one table can be exposed under several keys, each with its own rules).
- Join keys are backend-declared ALIASES (default: the joined table name).
- Write responses return PKs only. Send only real schema fields in write bodies: unknown ones are dropped or rejected (400), depending on the server.
- Composite-PK tables have no get/delete/bulk-delete routes (404): use search / update.

## Endpoints

```
POST {p}/search/{table} body=search request → {table, main:[...], ...}
GET {p}/rest/{table}/:id → {main:{...}} | 404
POST {p}/rest/{table} body={main, secondaries?} → 201 {main:{id}, secondaries?}
PUT {p}/rest/{table} body={main(+PK), secondaries?, deletions?} → {main:{id}, secondaries?, deletions?}
DELETE {p}/rest/{table}/:id → {main:{id}} | 404
PUT {p}/bulk/{table} body=[{main, secondaries?, deletions?}, ...] → [{main:{id}}, ...]
POST {p}/bulk/{table}/delete body=[{id:1}, {id:2}] → [{main:{id:1}}, ...] // key = the table's PK field
```

## Search

Querystring, all optional: `orderBy`, `page`, `itemsPerPage`, `computeMin|Max|Sum|Avg=<field>`. Body, all optional and combinable; `{}` returns the first N rows.

```jsonc
// POST {p}/search/customer?orderBy=orders.sum.total DESC, creator.name ASC, id&page=1&itemsPerPage=20&computeSum=total
{
  "filters": { "status": "active", "deletedById": null }, // equality, AND; null → IS NULL; also computed fields and backend extra filters (see manifest). Unknown key → 400
  "conditions": [ // AND; the same field may repeat
    { "field": "total", "method": "isBetween", "params": [100, 500] },
    { "field": "name", "method": "isILike", "params": ["%mario%"] },
    { "field": "status", "method": "isIn", "params": [["active", "pending"]] },
    { "field": "orders.count.id", "method": "isGreaterOrEqual", "params": [4] } // alias.fn.field, HAVING-style: needs the matching joinGroup below
  ],
  "selectComputed": ["displayName"], // computed fields are projected into main rows only when listed
  "joinMustExist": { // EXISTS on children: decides WHICH main rows return; fetches nothing
    "labels": { "filters": { "labelId": 1 }, "conditions": [] }
  },
  "joinMultiple": { // side query: child rows of the returned main rows
    "orders": { "filters": { "status": "pending" }, "conditions": [], "selection": "id,total,status" }
  },
  "joinGroup": { // aggregates child rows of the returned main rows
    "orders": {
      "aggregations": { "by": "status", "sum": ["total"], "min": ["total"], "max": ["total"], "avg": ["total"], "count": ["id"], "distinctCount": ["status"] }, // by: optional GROUP BY (field or computed)
      "filters": { "status": "active" }, "conditions": [] // narrow children before aggregating
    }
  },
  "joinLeft": { // N:1 parent (alias declared unique by the backend)
    "creator": { "selection": "id,name", "filters": {}, "conditions": [] } // filters here EXCLUDE mains whose parent does not match; no extra filters here
  }
}
```

Response; each section is present only if requested:

```jsonc
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "creatorId": 7, "displayName": "..." }],
  "joinMultiple": { "orders": [{ "id": 10, "customerId": 1, "total": 50 }] }, // flat list for all mains: group client-side by FK
  "joinGroup": { "orders": {
    "sum": { "total": 150 }, // no "by": ONE total over the children of ALL returned mains
    "rows": [{ "by": "pending", "sum_total": 100 }] // with "by": one row per group; by = FK field gives per-main values
  }},
  "joinLeft": { "creator": [{ "id": 7, "name": "Alice" }] }, // deduplicated: match main.creatorId === creator.id
  "pagination": { // only when page or itemsPerPage is sent
    "total": 25, "pages": 3,
    "computed": { "sum": { "total": 999 } }, // computeMin/Max/Sum/Avg over all matching rows; require pagination
    "paginator": { "page": 1, "itemsPerPage": 20 }
  }
}
```

Pagination:
- Without `page`/`itemsPerPage`, the server caps rows at its maximum (default 1000) and returns no `pagination` block.
- With `page` only, `itemsPerPage` defaults to 500 (or the server maximum if lower).
- Both are integers ≥ 1. `itemsPerPage` above the server maximum → 400.

`orderBy` is a comma-separated list, each part one of:
- `field [ASC|DESC]`, including computed fields.
- `alias.parentField`: joinLeft alias; adds the LEFT JOIN.
- `alias.fn.field`, with fn one of `sum|min|max|avg|count|distinctCount`. The joinGroup with that fn and field must be in the body.

For `alias.fn.field`, in both `orderBy` and conditions, the joinGroup `by` must be absent or equal to the FK (else 400). In `orderBy` it is also a 400 on tables with distinct results.

A main without children (or none left after the joinGroup filters) has `count`, `distinctCount` and `sum` = 0, but `min`, `max` and `avg` = null. Null sorts where the database puts it (PostgreSQL: last in ASC, first in DESC; MySQL/MariaDB: first in ASC, last in DESC) and fails every comparison: `max < 5` excludes such mains; `isNull` selects them.

Condition methods and `params` arity:
- `[v]`: `isEqual|isNotEqual|isGreater|isGreaterOrEqual|isLess|isLessOrEqual|isNotGreater|isNotGreaterOrEqual|isNotLess|isNotLessOrEqual`
- `["%p%"]`: `isLike|isNotLike|isILike|isNotILike`
- `[from, to]`: `isBetween|isNotBetween`
- `[[v1, v2]]`: `isIn|isNotIn`
- `[]`: `isNull|isNotNull`

An unknown field or method, or `params` that is not an array or is too short → 400.

## Writes

```jsonc
// POST {p}/rest/customer — insert; omit auto-generated PKs
{ "main": { "name": "Mario", "email": "m@t.it" },
  "secondaries": { "orders": [{ "total": 50, "status": "pending" }] } } // child FK auto-filled from the new main PK
// → 201 { "main": { "id": 1 }, "secondaries": { "orders": [{ "id": 10 }] } }

// PUT {p}/rest/customer — update; main MUST include the PK; send only the fields to change; null sets NULL
{ "main": { "id": 1, "email": "new@t.it" },
  "secondaries": { "orders": [{ "total": 75 }] }, // insert (or upsert) children, FK auto-filled
  "deletions": { "orders": [{ "id": 10 }] } } // delete children by PK, only children of this main
// → 200 { "main": { "id": 1 }, "secondaries": { "orders": [{ "id": 20 }] }, "deletions": { "orders": [{ "id": 10 }] } }

// PUT {p}/bulk/customer — bulk upsert; items need not share keys: an omitted field keeps the stored value (update) or takes the column default (insert)
[ { "main": { "name": "Mario" }, "secondaries": { "orders": [{ "total": 50 }] } },
  { "main": { "name": "Luigi" } } ]
// → 200 [ { "main": { "id": 1 }, "secondaries": {...} }, { "main": { "id": 2 } } ]
```

Upsert tables (see manifest):
- Every row, main or child, carries its conflict key: missing, null, or shared by two rows of one request → 400.
- When the key is the id, rows without an id are inserted.
- Bulk arrays are capped (default 1000): chunk client-side.

## Errors

Every error has one shape. `error` is the HTTP reason phrase; `requestId` is the server log's `reqId`, quote it when reporting a problem.

```json
{ "statusCode": 400, "error": "Bad Request", "message": "Validation failed", "requestId": "req-1",
  "fields": [ { "path": "main.name", "code": "required", "message": "must have required property 'name'" } ] }
```

- 400 always carries `fields`, whether the request failed the schema, the backend's business validation or the engine. Map `fields[].path` to form fields; when `fields` is empty, show `message`.
  - `path` is the dot path of the offending value in the request: body keys from the root (`main.name`, `secondaries.orders.0.total`, `filters.status`, `conditions.2.params`, `joinGroup.orders.aggregations.by`, `joinMultiple.orders.selection`), querystring and path parameters by name (`orderBy`, `itemsPerPage`, `id`). `""` when the error is not attributable to one input.
  - `code` is stable: an Ajv keyword (`required`, `type`, `maximum`, `additionalProperties`, `enum`…), a code the backend chose in its own validation, or an engine code: `unknown_field`, `not_readable`, `unknown_alias`, `wrong_join_family`, `invalid_method`, `invalid_params`, `invalid_order_by`, `invalid_paginator`, `invalid_aggregation`, `undeclared_aggregation`, `bound_values_not_allowed`, `extra_filter_not_allowed`, `limit_exceeded`, `missing_key`, `duplicate_key`, `ambiguous_tenant`. The engine's `message` repeats the field's.
- 403: tenant violation. 404: record not found, or outside your tenant. No `fields`.
- 500: DB errors (e.g. constraint violations), unmapped: `message` is fixed, the detail is in the server log under `requestId`.
- Per search, max 100 `conditions` per section (top level and each join) and max 20 `orderBy` parts (≤ 1024 chars); over either → 400 `limit_exceeded`. Collapse many equality conditions into one `isIn`.
