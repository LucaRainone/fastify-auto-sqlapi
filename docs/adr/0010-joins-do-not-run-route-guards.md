# 0010. A declared join is a read grant — joins do not run the target table's route guards

- **Status**: accepted
- **Date**: 2026-07-30

## Context

`onRequests` and `operations` are configured per table, which reads as "this table's
protection". They are not. Both are properties of the *routes generated for* a table:
`mergeOnRequests` composes the global and per-table hooks into `fastify.route({ onRequest })`,
and `operations` decides which routes get registered at all.

A join is resolved inside the query of the **host** table's route. `searchEngine` validates a
join alias against the host's `allowedReadJoins` and nothing else — it never looks up the
target's `operations`, and no Fastify hook fires mid-query. So:

```typescript
// agent: readable by every employee
allowedReadJoins: [buildRelation(SchemaAgent, 'userId', SchemaUser, 'id', { unique: true })],

// user: admins only... except through the join above
const TableUser = defineTable({
  ...exportTableInfo(SchemaUser),
  onRequests: [requireAdmin],
  operations: [],          // no HTTP routes at all
});
```

`POST /search/agent` with `joinLeft: { user: { selection: 'id,email' } }` returns the emails.
`requireAdmin` never ran, and `operations: []` did not matter: the caller was authorized as a
reader of `agent`, and the join is part of what `agent` exposes.

Reviewers reach this and read it as a hole to plug. It is a boundary, and the boundary needs
to be stated rather than discovered.

## Decision

**Declaring a relation in `allowedReadJoins` grants read access to the target table, under
the authorization of the host table.** The target's own route guards do not apply and are not
made to apply.

Route-level controls (`onRequests`, `operations`) do not follow joins. Configuration-level
controls do, and are the ones to use on a join target:

| Control | Follows a join | Granularity |
|---|---|---|
| `onRequests` | no | per route |
| `operations` | no | per route |
| `readExclude` | yes | per table, static |
| the relation's `Schema` + `selection` | yes | per relation, static |
| `tenantScope` + `getTenantId` | yes | per request |

To expose a table broadly while keeping some of its columns narrow, declare the relation
against a **trimmed copy of the Schema** and give it an explicit `selection`:

```typescript
const SchemaUserPublic = { ...SchemaUser, fields: { id: SchemaUser.fields.id, name: SchemaUser.fields.name } };

buildRelation(SchemaAgent, 'userId', SchemaUserPublic, 'id', { unique: true, selection: 'id, name' })
```

Every read surface validates against the schema the relation was declared with — `selection`,
`filters`, `conditions`, `orderBy`, aggregations — so a field outside it is `400 Unknown
field`, not a hidden column. The explicit `selection` is not redundant: a relation left at the
default `'*'` emits a literal `SELECT *` when the target declares no `readExclude`, and the
extra columns are dropped only by the response serializer — they are still present on the
programmatic `sqlApi.search()` path.

## Alternatives considered

- **Run the target's `onRequests` when it is joined** — rejected: a Fastify request hook may
  reply and terminate; there is no coherent meaning for that halfway through building one
  table's query. It would also fire N times per request with no request lifecycle to attach to.
- **`canBeJoined?: (request) => Promise<boolean>` on `ITable`** — rejected: wrong granularity.
  The real cases are "join yes, this column no", which a boolean cannot express, and the
  refusal has no good answer (a `400` leaks the relation's existence; omitting the join
  silently is indistinguishable from "no related rows"). It also adds a per-join await and
  cannot be enforced for programmatic callers.
- **Make the relation's `selection` a ceiling instead of a default** — rejected: breaking, and
  it does not solve the case it looks like it solves. A ceiling is still static, and it caps
  only the projection: the excluded field stays filterable through `conditions`, which is the
  bisection leak `readExclude` exists to prevent. Trimming the schema closes every surface at
  once.
- **Refusing to register a table that is a join target of a less-protected table** — rejected:
  the plugin has no way to compare two `onRequests` arrays for strictness, and ADR 0002 says
  auth is the consumer's to model.

## Consequences

- `allowedReadJoins` must be read as a security decision, not just an ergonomics one. Adding a
  relation widens the reachable data set for everyone authorized on the host table.
- Column-level protection that depends on the caller's role has no mechanism today.
  `readExclude` is per table and static; the trimmed schema is per relation and static. The
  known gap is a request-resolved `readExclude`, which would work without new plumbing at the
  join sites — every path already resolves it through `dbTables[joinSchema.tableName]` — but
  requires the generated response and filter schemas to stay the widest set and the runtime to
  narrow. Not decided here.
- `tenantScope` remains the one request-derived protection that crosses joins, and is the
  precedent for the shape any future one should take: table configuration plus a plugin-level
  resolver, not a route hook.
