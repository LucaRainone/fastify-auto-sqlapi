# 0028. `'*'` in `select` is the default projection — a computed field is asked for without copying the readable set

- **Status**: accepted
- **Date**: 2026-11-16

## Context

A search without `select` returns every readable field of the main table — the schema minus
`readExclude` — and no computed field: a computed field is a SQL expression, evaluated only
when asked for. With `select`, the response carries the listed fields only.

Before 1.0, `selectComputed` alone meant "every column plus these computed fields". 1.0 folded
it into `select` (ADR 0027, one name, one place), and that meaning went with it: to get one
computed field, a client had to list every other field it reads.

A consumer migrating to 1.0 did exactly that: it generated the table's readable fields into a
constant and sent it with every search. That list is a client-side copy of server
configuration, and it drifts from it:

- a column moved into `readExclude` turns every search listing it into a 400 `not_readable`;
- a column added to the schema reaches the clients that send no `select`, and not the ones
  that list fields to get a computed one.

So "everything, plus `fullName`" and "everything" stopped meaning the same "everything" as
soon as the schema or `readExclude` changed — the opposite of what `readExclude` is for: the
server decides what is readable, once.

## Decision

**In the main `select`, `'*'` stands for the default projection: every readable field, as a
search without `select` returns.** `['*', 'fullName']` is every readable field plus the
computed field `fullName`.

- `'*'` may stand anywhere in the list: the list is a set of fields, not an ordered one. A
  schema field listed next to it adds nothing.
- The other names are validated as without it: an unknown name is a 400 `unknown_field`, a
  `readExclude`d one a 400 `not_readable`, at `select.<i>`.
- It is the main projection only. A join's `select` admits no computed field, so `'*'` there
  would mean what an absent `select` already means: it is a 400 `unknown_field`.
- The same holds in `sqlApi.search()`, which takes the HTTP body.

## Alternatives considered

- **Keep the explicit list** (the 1.0 rule). Every client that wants one computed field
  maintains a copy of the readable set, and breaks or silently lags when the server changes
  it. The cost falls on every consumer, permanently, to spare the server one token.
- **A second key for computed fields** (`computed: ['fullName']`, or bringing back
  `selectComputed`). Two keys for one projection, and two ways to name a computed field — the
  ambiguity ADR 0027 removed. `'*'` keeps one key: `select` still lists what the row carries.
- **Project every computed field by default.** A computed field is an expression the database
  evaluates per row, possibly a subquery; paying for all of them on every search to save a
  client one name inverts the cost. And the response of a plain search would change each time
  a computed field is declared.
- **Allow `'*'` as the first element only.** One more rule and one more error code for no
  gain: the position of `'*'` changes nothing in the result.

## Consequences

- A client asks for computed fields with `['*', …]` and keeps no list of the readable fields;
  `readExclude` is the one place that decides them, for every client.
- `'*'` is the only name in `select` that is not a field. A tool reading `select` as a list of
  field names must skip it. A column literally named `*` (possible only as a quoted
  identifier) can no longer be selected by name; it is still in the default projection.
- Adding it is backward compatible: before, `'*'` was a 400 `unknown_field`.
