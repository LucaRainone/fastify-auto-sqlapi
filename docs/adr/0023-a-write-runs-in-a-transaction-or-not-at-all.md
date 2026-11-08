# 0023. A write runs in a transaction or not at all — `withTransaction` requires `connect()`

- **Status**: accepted
- **Date**: 2026-11-09

## Context

A single insert or update is several statements: the main row, its secondaries, its
deletions, and the `afterInsert`/`afterUpdate` hook, which the docs promise can roll
everything back by throwing. They run inside `QueryClient.withTransaction`, which needs a
dedicated connection and therefore a `Queryable` with `connect()`. The two built-in adapters
provide it from a pool.

`connect()` is optional in the `Queryable` type, so that a custom adapter — a single query
function over some driver — keeps working. `withTransaction` honoured that by *degrading*:
without `connect()` it ran its callback directly on the pooled client, with no BEGIN and no
ROLLBACK. The write pipeline did not know. A secondary failing after the main row was
inserted left the main row behind; an `afterUpdate` throwing to "roll back" rolled back
nothing. Every part of the API still answered as if the guarantee held, and the one hint was a
sentence in a doc comment. ADR 0003 even cited the degrade as graceful.

## Decision

**`withTransaction` runs its callback inside a transaction or throws.** Without `connect()`
on the `Queryable` it fails before running anything, with a message naming the fix. The only
exception is the client it hands its own callback: that one wraps the transaction's
connection, has no `connect()` either, and an inner `withTransaction` joins the outer one.

`connect()` stays optional in the type: a read-only client — a custom adapter behind
`searchRoutes` and `getRoutes` only — needs no transactions and must not be forced to fake
one. Reads never call `withTransaction`. The plugin logs a warning once when the client it was
given cannot do transactions, so the misconfiguration is seen before the first write.

## Alternatives considered

- **Keep degrading, document it louder** — rejected: a guarantee the consumer cannot observe
  being dropped is not a guarantee. `afterUpdate` is documented as "throw = rollback"; a
  configuration that silently makes that false is a correctness bug, not a compatibility
  feature.
- **Degrade only when the write is a single statement** (no secondaries, deletions or
  after-hooks) — rejected: it is correct, but it makes "does this adapter work?" depend on
  the request body. A deployment would pass every test with plain rows and fail on the first
  real one. One rule is easier to hold: a write needs transactions, full stop.
- **Fail at startup when the client has no `connect()`** — rejected as the only mechanism: a
  read-only surface over a custom adapter is a supported setup, and refusing to start would
  outlaw it. Kept as a warning, because in every other setup it is a misconfiguration worth
  seeing early.
- **Synthesise `connect()` from a single connection** — rejected: a driver client that is
  not a pool cannot hand out a dedicated connection; faking one by running BEGIN on the shared
  client would serialise every request of the process through one transaction.

## Consequences

- A custom `Queryable` without `connect()` can serve reads, and gets a 500 with an explicit
  message on the first insert or update (and a startup warning). Adding `connect()` to the
  adapter is the migration; the built-in adapters are unaffected.
- The sentence in ADR 0003's context describing the degrade as graceful is superseded by
  this decision; ADR 0003's own decision — bulk operations stay non-transactional — stands.
- Test doubles for the database must offer `connect()` to exercise writes, as the real
  adapters do; the shared harness mock does.
