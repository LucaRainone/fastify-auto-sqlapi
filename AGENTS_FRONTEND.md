# fastify-auto-sqlapi — client API (LLM reference)

This file is the request GRAMMAR. For this deployment's tables/fields/aliases (the
vocabulary), fetch `GET {p}/agent/manifest.md` if available, or consult Swagger.

Rules: all request/response fields camelCase. `{p}` = deployment prefix (e.g. `/api`). Join keys are backend-declared ALIASES (default = joined table name; list per table in Swagger). Write responses are PK-only. Write bodies reject unknown properties (400) — send only real schema fields. Arrays for bulk are capped (default 1000/request; chunk client-side). Composite-PK tables have no get/delete/bulk-delete (404) — use search / update.

## Endpoints

```
POST   {p}/search/{table}        body=search request           → {table, main:[...], ...}
GET    {p}/rest/{table}/:id                                    → {main:{...}} | 404
POST   {p}/rest/{table}          body={main, secondaries?}     → 201 {main:{id}, secondaries?}
PUT    {p}/rest/{table}          body={main(+PK), secondaries?, deletions?} → {main:{id}, ...}
DELETE {p}/rest/{table}/:id                                    → {main:{id}} | 404
PUT    {p}/bulk/{table}          body=[{main, secondaries?, deletions?},...] → [{main:{id}},...]
POST   {p}/bulk/{table}/delete   body=[{id:1},{id:2}]          → [{main:{id:1}},...]
```

## SEARCH

Query string (all optional): `?orderBy=...&page=1&itemsPerPage=20&computeMin=f&computeMax=f&computeSum=f&computeAvg=f`
Body (all optional; `{}` = first N rows). Everything below is combinable in one request:

```jsonc
// POST {p}/search/customer?orderBy=orders.sum.total DESC, creator.name ASC, id&page=1&itemsPerPage=20&computeSum=total
{
  "filters": { "status": "active", "deletedById": null },   // equality AND; null → IS NULL; extraFilters names (backend-defined, see manifest) also accepted here
  "conditions": [                                            // advanced, AND, same field repeatable
    { "field": "total", "method": "isBetween", "params": [100, 500] },
    { "field": "name", "method": "isILike", "params": ["%mario%"] },
    { "field": "status", "method": "isIn", "params": [["active", "pending"]] },
    { "field": "orders.count.id", "method": "isGreaterOrEqual", "params": [4] }  // HAVING-style: needs matching joinGroup below
  ],
  "selectComputed": ["displayName"],       // backend computed fields, projected into main rows only if listed
  "joinMustExist": {                       // EXISTS on child: filters WHICH main rows return; no data fetched
    "labels": { "filters": { "labelId": 1 }, "conditions": [] }
  },
  "joinMultiple": {                        // side query: fetches child rows OF the returned mains
    "orders": { "filters": { "status": "pending" }, "selection": "id,total,status" }
  },
  "joinGroup": {                           // aggregations on child rows
    "orders": {
      "aggregations": {
        "by": "status",                    // optional GROUP BY (schema field or backend computed, e.g. month bucket)
        "sum": ["total"], "min": ["total"], "max": ["total"], "avg": ["total"],
        "count": ["id"], "distinctCount": ["status"]
      },
      "filters": { "status": "active" }    // narrows child rows before aggregating
    }
  },
  "joinLeft": {                            // N:1 parent embed (alias declared unique by backend)
    "creator": { "selection": "id,name" }  // filters/conditions here EXCLUDE mains whose parent doesn't match; schema fields only (extraFilters NOT usable here)
  }
}
```

Response (each section present only if requested):

```jsonc
{
  "table": "customer",
  "main": [{ "id": 1, "name": "Mario", "creatorId": 7, "displayName": "..." }],
  "joinMultiple": { "orders": [{ "id": 10, "customerId": 1, "total": 50 }] },
  "joinGroup": { "orders": {
    "sum": { "total": 150 },                                  // keyed by fn when no "by"
    "rows": [{ "by": "pending", "sum_total": 100 }]           // rows[] when "by" is set
  }},
  "joinLeft": { "creator": [{ "id": 7, "name": "Alice" }] },  // deduped; map client-side: main.creatorId === creator.id
  "pagination": {                                             // present when page/itemsPerPage sent
    "total": 25, "pages": 3,
    "computed": { "sum": { "total": 999 } },                  // computeMin/Max/Sum/Avg (require pagination)
    "paginator": { "page": 1, "itemsPerPage": 20 }
  }
}
```

`orderBy` forms (comma-separable): `field [ASC|DESC]` | `alias.parentField` (joinLeft-eligible alias, adds LEFT JOIN) | `alias.fn.field` (fn: sum|min|max|avg|count|distinctCount — the joinGroup with that fn+field MUST be in the body; rows without children sort as 0). For 3-part orderBy and HAVING-style conditions: `aggregations.by` is allowed only when it equals the correlation FK (else 400); aggregation orderBy is rejected (400) on tables with distinctResults.

Condition methods (params arity): `isEqual|isNotEqual|isGreater|isGreaterOrEqual|isLess|isLessOrEqual|isNotGreater|isNotGreaterOrEqual|isNotLess|isNotLessOrEqual` → `[v]`; `isLike|isNotLike|isILike|isNotILike` → `["%p%"]`; `isBetween|isNotBetween` → `[from,to]`; `isIn|isNotIn` → `[[v1,v2]]`; `isNull|isNotNull` → `[]`. Unknown field or method → 400.

## WRITES

```jsonc
// POST {p}/rest/customer  (insert; omit auto-generated PKs)
{ "main": { "name": "Mario", "email": "m@t.it" },
  "secondaries": { "orders": [{ "total": 50, "status": "pending" }] } }  // child FK auto-filled from new main PK
// → 201 { "main": { "id": 1 }, "secondaries": { "orders": [{ "id": 10 }] } }

// PUT {p}/rest/customer  (update; main MUST include PK; partial fields ok; null = set column NULL)
{ "main": { "id": 1, "email": "new@t.it" },
  "secondaries": { "orders": [{ "total": 75 }] },      // inserts/upserts children, FK auto-filled
  "deletions":   { "orders": [{ "id": 10 }] } }        // deletes children by PK (scoped to this main)
// → 200 { "main": { "id": 1 }, "secondaries": { "orders": [{ "id": 20 }] }, "deletions": { "orders": [{ "id": 10 }] } }

// PUT {p}/bulk/customer  (bulk upsert; one SQL for mains; per-item secondaries/deletions)
[ { "main": { "name": "Mario" }, "secondaries": { "orders": [{ "total": 50 }] } },
  { "main": { "name": "Luigi" } } ]
// → 200 [ { "main": { "id": 1 }, "secondaries": {...} }, { "main": { "id": 2 } } ]
```

## Errors

400 (schema or business validation) — map `fields[].path` to form fields:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "Validation failed",
  "fields": [ { "path": "body.main.name", "code": "required", "message": "must have required property 'name'" } ] }
```

Other: 404 (get/delete not found), 400 `itemsPerPage exceeds the maximum` (lower it), 500 raw DB errors (constraint violations surface unmapped).
