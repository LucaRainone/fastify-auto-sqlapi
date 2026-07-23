# 0003. Bulk operations are not transactional

- **Status**: accepted
- **Date**: 2026-07-23 (confirmed by the maintainer in June 2026)

## Context

Single insert and update run inside a transaction: main record, secondaries, deletions
and after-hooks are atomic (`QueryClient.withTransaction`, degrading gracefully when the
adapter has no `connect()`). Bulk upsert and bulk delete do not — a failure partway
through leaves the earlier items committed. Reviews periodically report this as an
inconsistency and propose wrapping bulk operations in a transaction.

## Decision

Bulk operations stay non-transactional. They are a shortcut for issuing many single
operations efficiently, not an atomic batch primitive: "all or nothing" is explicitly not
part of their contract.

## Alternatives considered

- **Wrap each bulk request in one transaction** — rejected: changes the semantics from
  "N independent operations" to "one atomic batch", which is a different feature. Large
  batches would also hold long transactions with the associated lock footprint.
- **Opt-in `transactional: true` flag** — rejected for now: adds API surface for a need
  no consumer has expressed; a consumer needing atomicity can call the programmatic
  `sqlApi.*` methods inside their own `withTransaction`.

## Consequences

- A failed bulk request may have partially applied. Consumers that care must either
  retry idempotently (upsert semantics make this natural) or manage their own
  transaction via the programmatic API.
- Bulk delete reports the ids actually deleted (`afterBulkDelete` receives the actual
  subset), which is the honest contract for a non-atomic batch.
