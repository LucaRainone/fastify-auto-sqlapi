# 0020. No conditional or mass update route — a predicate write is a custom route

- **Status**: accepted
- **Date**: 2026-09-24

## Context

The `update` route addresses exactly one row: its `WHERE` is every primary key column plus
the tenant scope, and nothing the client sends can add to it. Two real needs fall outside
that shape:

- **Compare-and-set.** Claiming a row so that two clients cannot both claim it
  (`UPDATE … SET in_progress_since = now() WHERE id = ? AND in_progress_since IS NULL`),
  guarded state transitions (`… AND status = 'draft'`), optimistic locking on a `version`
  column. Correctness depends on the check and the write being one statement; a
  `beforeUpdate` that reads first and writes after is exactly the race it is meant to
  prevent.
- **Mass update by predicate.** Setting a value on every row matching a filter.

A route was designed to cover both: a new `updateWhere` operation, opt-in (registered only
when listed in `operations`), `PUT {p}/update/{key}` with `{ where: { filters, conditions },
fields }` reusing the search grammar, the tenant guard injected, `validate`/`beforeUpdate`
run on `fields`, `{ affected }` in response. Compare-and-set is then a `where` that includes
the primary key.

## Decision

The plugin does not expose a conditional or mass update route, and the single-row `update`
does not accept a precondition. A write whose target is a predicate is built as a custom
route on `QueryClient.update(table, fields, where, extraCondition)`, which already takes a
`ConditionBuilder` and returns the number of rows it changed.

The design was sound; the cost was not worth it. It is the first route that writes N rows
chosen by the client, so a defect in it is destructive and tenant-crossing rather than a
wrong answer. Building it touches several security-sensitive pieces at once:

- `QueryClient.update`, which today assumes an equality `where` and would emit `WHERE  AND …`
  for a condition-only one;
- the search condition builder, shared with every read;
- the tenant guards, which on update are keyed on a primary key (`assertTenantOwnership`)
  and would need the row-guard form for indirect scopes instead;
- the meaning of `validate`, `beforeUpdate` and `afterUpdate`, whose `record` would no longer
  carry a primary key — breaking any existing hook that reads one.

Against that, the need is narrow and the custom route is a few lines, owned by the consumer
who knows the predicate it must enforce.

## Alternatives considered

- **`updateWhere` operation, opt-in** — the design above. Rejected for the risk and blast
  radius described in the decision, not for a flaw in its shape.
- **`expect` on the single-row `update`** (a precondition next to the primary key, `409` when
  it fails) — rejected: it narrows the write instead of widening it, so the blast radius is
  small, but it still reopens the update `WHERE` to client-supplied predicates, and it needs
  a readability rule to avoid an oracle (see Consequences). One custom route covers it.
- **Read-then-write in `beforeUpdate`** — not an alternative: two concurrent requests both
  pass the read.

## Consequences

- Compare-and-set and predicate updates are custom routes. [AGENTS_BACKEND.md](../../AGENTS_BACKEND.md)
  carries the pattern ("Conditional update — claim a row atomically").
- Everything the auto routes do for free is the custom route's job there: `QueryClient` runs
  no hooks, no validation and **no tenant scoping**, so the route must add its own tenant
  predicate and must not let a client-chosen predicate reach a column the caller cannot read —
  otherwise `affected: 0 | 1` becomes an oracle on its value.
- Revisit only with a concrete, repeated need that a custom route serves badly; the design
  notes above are the starting point.
