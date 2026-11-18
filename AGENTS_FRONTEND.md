# fastify-auto-sqlapi — client API (LLM reference)

This is the request GRAMMAR. The vocabulary (this deployment's tables, fields, join aliases, computed fields, extra filters) comes from `GET {p}/agent/manifest.md` when enabled, or from Swagger.

- All request/response fields are camelCase schema field names; the server maps them to columns.
- `{p}` = deployment prefix (e.g. `/api`). `{table}` = the table's key in the manifest, which may differ from the DB table name (one table can be exposed under several keys, each with its own rules).
- Join keys are backend-declared ALIASES (default: the joined table name).
- Write responses return PKs only. Send only real schema fields in write bodies: unknown ones are dropped or rejected (400), depending on the server.
- Composite-PK tables have no get/delete-by-`:id` routes (404): read with search, write with update, delete with bulk delete, one object per key.

## Endpoints

```
POST {p}/search/{table} body=search request → {table, main:[...], ...}
GET {p}/rest/{table}/:id → {main:{...}} | 404
POST {p}/rest/{table} body={main, upsert?, replace?} → 201 {main:{id}, action, secondaries?, deletions?} // action: "inserted" | "updated" (upsert tables); deletions: only from a replace
PUT {p}/rest/{table} body={main(+PK), upsert?, delete?, replace?} → {main:{id}, secondaries?, deletions?}
DELETE {p}/rest/{table}/:id → {main:{id}} | 404
PUT {p}/bulk/{table} body=[{main, upsert?, delete?, replace?}, ...] → [{main:{id}, action, secondaries?, deletions?}, ...]
POST {p}/bulk/{table}/delete body={ids:[1, 2]} → [{main:{id:1}}, ...] // only the rows actually deleted; main key = the table's PK field
// composite PK: one object per key, every key field: body={ids:[{postId:1, tagId:2}]} → [{main:{postId:1, tagId:2}}, ...]
```

## Search

Everything travels in the body, and only there; all keys are optional and combinable, `{}` returns the first N rows. `orderBy`, `page`, `itemsPerPage` or `computeMin|Max|Sum|Avg` in the querystring → 400 `retired_key` at that key.

```jsonc
// POST {p}/search/customer
{
  "orderBy": "orders.sum.total DESC, creator.name ASC, id", // see orderBy below
  "paginator": { "page": 1, "itemsPerPage": 20 }, // see Pagination
  "compute": { "sum": ["total"], "count": ["id"] }, // min|max|sum|avg|count|distinctCount over ALL matching rows, not the page → computed; paginator not needed
  "filters": { "status": "active", "deletedById": null }, // equality, AND; null → IS NULL; also computed fields and backend extra filters (see manifest). Unknown key → 400
  "conditions": [ // AND; the same field may repeat
    { "field": "total", "method": "isBetween", "params": [100, 500] },
    { "field": "name", "method": "isILike", "params": ["%mario%"] },
    { "field": "status", "method": "isIn", "params": [["active", "pending"]] },
    { "field": "orders.count.id", "method": "isGreaterOrEqual", "params": [4] } // alias.fn.field, HAVING-style: needs the matching joinGroup below
  ],
  "select": ["id", "name", "displayName"], // main fields to return, computed ones included; default: every readable field and no computed one. "*" = that default: ["*", "fullName"] adds a computed field without listing the rest (main select only). The PK and the keys of the requested joins are always included. Unknown or hidden name → 400
  "joinMustExist": { // EXISTS on child rows: decides WHICH main rows return; fetches nothing
    "labels": { "filters": { "labelId": 1 }, "conditions": [] }
  },
  "joinMultiple": { // side query: child rows of the returned main rows
    "orders": { "filters": { "status": "pending" }, "conditions": [], "select": ["customerId", "id", "total", "status"] } // default set by the backend; a select returns only what it lists — include the FK (customerId) to tell which main row a child belongs to
  },
  "joinGroup": { // aggregates child rows of the returned main rows
    "orders": {
      "by": "customerId", // optional GROUP BY (field or computed); absent or the FK when alias.fn.field is in orderBy or conditions
      "sum": ["total"], "min": ["total"], "max": ["total"], "avg": ["total"], "count": ["id"], "distinctCount": ["status"], // at least one
      "filters": { "status": "active" }, "conditions": [] // narrow the child rows before aggregating
    }
  },
  "joinLeft": { // N:1 parent (alias declared unique by the backend)
    "creator": { "select": ["id", "name"], "filters": {}, "conditions": [] } // filters here EXCLUDE mains whose parent does not match; no extra filters here
  }
}
```

Response; each section is present only if requested:

```jsonc
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "creatorId": 7, "displayName": "..." }],
  "joinMultiple": { "orders": [{ "id": 10, "customerId": 1, "total": 50 }] }, // flat list for all mains: group client-side by FK
  "joinGroup": { "orders": { "rows": [ // always rows, [] when no main matched
    { "by": 1, "sum": { "total": "100.00" }, "count": { "id": "2" } } // with "by": one row per group; by = FK field gives per-main values. Aggregates come as the database returns them: often strings, exact — parse them
  ]}}, // without "by": ONE row, no "by", over the child rows of ALL returned mains
  "joinLeft": { "creator": [{ "id": 7, "name": "Alice" }] }, // deduplicated: match main.creatorId === creator.id
  "computed": { "sum": { "total": "999.00" }, "count": { "id": "25" } }, // only when compute is sent: one entry per function and field; values as in joinGroup
  "pagination": { // only when paginator is sent, even {}
    "total": 25, "pages": 3,
    "paginator": { "page": 1, "itemsPerPage": 20 }
  }
}
```

Pagination:
- Without `paginator`, the server caps rows at its maximum (default 1000) and returns no `pagination` block.
- With `page` only, `itemsPerPage` defaults to 500 (or the server maximum if lower); with `itemsPerPage` only, `page` defaults to 1.
- Both are integers ≥ 1. `itemsPerPage` above the server maximum → 400.

`orderBy` is a comma-separated list, each part one of:
- `field [ASC|DESC]`, including computed fields.
- `alias.parentField`: joinLeft alias; adds the LEFT JOIN.
- `alias.fn.field`, with fn one of `sum|min|max|avg|count|distinctCount`. The joinGroup with that fn and field must be in the body.

For `alias.fn.field`, in both `orderBy` and conditions, the joinGroup `by` must be absent or equal to the FK (else 400). In `orderBy` it is also a 400 on tables with distinct results.

A main without child rows (or none left after the joinGroup filters) has `count`, `distinctCount` and `sum` = 0, but `min`, `max` and `avg` = null. Null sorts where the database puts it (PostgreSQL: last in ASC, first in DESC; MySQL/MariaDB: first in ASC, last in DESC) and fails every comparison: `max < 5` excludes such mains; `isNull` selects them.

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
  "upsert": { "orders": [{ "total": 50, "status": "pending" }] } } // child FK auto-filled from the new main PK
// → 201 { "main": { "id": 1 }, "action": "inserted", "secondaries": { "orders": [{ "id": 10 }] } }

// PUT {p}/rest/customer — update; main MUST include the PK; send only the fields to change; null sets NULL
{ "main": { "id": 1, "email": "new@t.it" },
  "upsert": { "orders": [{ "total": 75 }] }, // insert (or upsert) child rows, FK auto-filled; the others stay
  "delete": { "orders": [{ "id": 10 }] } } // delete child rows by PK, only those of this main
// → 200 { "main": { "id": 1 }, "secondaries": { "orders": [{ "id": 20 }] }, "deletions": { "orders": [{ "id": 10, "customerId": 1 }] } }

// PUT {p}/bulk/customer — bulk upsert; items need not share keys: an omitted field keeps the stored value (update) or takes the column default (insert)
[ { "main": { "id": 1, "name": "Mario" }, "upsert": { "orders": [{ "total": 50 }] } }, // customer has upsertKey [id] in the manifest
  { "main": { "name": "Luigi" } } ]
// → 200 [ { "main": { "id": 1 }, "action": "updated", "secondaries": {...} }, { "main": { "id": 2 }, "action": "inserted" } ]
// action: what the statement did to the main row. "updated" when an upsert rule matched an existing row (also with nothing left to change), "inserted" otherwise; tables without a rule always say "inserted".
// The request says what to do with child rows (upsert, delete, replace); the response says what happened: secondaries = rows written (PKs only), deletions = rows removed.
```

Child rows go in one section per action, by write alias (manifest):
- `upsert`: write these rows; the other child rows stay.
- `delete` (update and bulk): delete these rows, named by their key; only child rows of this main.
- `replace`: these are all the child rows — the rows sent are upserted, every other child row of the main row is deleted. `[]` deletes them all. Only for a write alias with an `upsertKey` in the manifest.

```jsonc
// post 1 has tags 1 and 2
PUT {p}/rest/post { "main": { "id": 1 }, "replace": { "tags": [{ "tagId": 2 }, { "tagId": 3 }] } }
// → 200 { "main": { "id": 1 }, "secondaries": { "tags": [...] }, "deletions": { "tags": [{ "postId": 1, "tagId": 1 }] } }
```

400, and nothing is written: an alias the table does not write (including one only readable), or `replace` on an alias without `upsertKey` → `unknown_field` at `<section>.<alias>` (`<i>.<section>.<alias>` in a bulk); one alias in `replace` and in `upsert` or `delete` too → `conflicting_alias` at `replace.<alias>`; the pre-1.0 `secondaries` / `deletions` keys → `retired_key`.

Upsert tables (`upsertKey` on the table in the manifest; on a write alias, it is the child rows' key):
- Every row, main or child, carries its conflict key: missing, null, or shared by two rows of one request → 400.
- When the key is the id, rows without an id are inserted. If the server generates ids (`serverGenerated` in the manifest), an id must name an existing row: none → 400 `not_found` at its path, nothing written.
- Bulk arrays are capped (default 1000): chunk client-side.

## Errors

Every error the plugin's routes raise has one shape (a route the backend did not register, e.g. get/delete on a composite-PK table, is the framework's plain 404, without `requestId`). `error` is the HTTP reason phrase; `requestId` is the server log's `reqId`, quote it when reporting a problem.

```json
{ "statusCode": 400, "error": "Bad Request", "message": "Validation failed", "requestId": "req-1",
  "fields": [ { "path": "main.name", "code": "required", "message": "must have required property 'name'" } ] }
```

- 400 always carries `fields`, whether the request failed the schema, the backend's business validation or the engine. Map `fields[].path` to form fields; when `fields` is empty, show `message`.
  - `path` is the dot path of the offending value in the request: body keys from the root (`main.name`, `upsert.orders.0.total`, `filters.status`, `conditions.2.params`, `joinGroup.orders.by`, `joinMultiple.orders.select.1`), path parameters and retired querystring keys by name (`id`, `orderBy`). `""` when the error is not attributable to one input.
  - `code` is stable: an Ajv keyword (`required`, `type`, `maximum`, `additionalProperties`, `enum`…), a code the backend chose in its own validation, or an engine code: `unknown_field`, `not_readable`, `unknown_alias`, `wrong_join_family`, `invalid_method`, `invalid_params`, `invalid_order_by`, `invalid_paginator`, `invalid_aggregation`, `undeclared_aggregation`, `bound_values_not_allowed`, `extra_filter_not_allowed`, `limit_exceeded`, `retired_key` (a key the API no longer reads, e.g. `selectComputed`, a join's `selection`, the search querystring, `secondaries`/`deletions` in a write), `conflicting_alias`, `missing_key`, `duplicate_key`, `not_found`, `ambiguous_tenant`. The engine's `message` repeats the field's.
  - `message`, when present, is a low-level description for the developer (Ajv's or the engine's, in English). A backend validation and a mapped DB error carry none: the code is the whole answer. Show the user a translation of `code`, never `message`.
- 401: on a table with tenant scope, the request carries no tenant (the backend's auth resolved none). 403: tenant violation. 404: row not found, or outside your tenant. No `fields`, except a mapped DB error (below).
- 500: DB errors (e.g. constraint violations): `message` is fixed, the detail is in the server log under `requestId`. The backend may answer some of them with another status instead (typically 409 on a duplicate): same envelope, plus `fields: [{ path: "", code }]` with a backend-chosen code to translate.
- Per search, max 100 `conditions` per section (top level and each join): over it → 400 `maxItems` at that `conditions`. `orderBy` takes max 20 `orderBy` parts (→ 400 `limit_exceeded`) in ≤ 1024 chars (→ 400 `maxLength`). Collapse many equality conditions into one `isIn`.
