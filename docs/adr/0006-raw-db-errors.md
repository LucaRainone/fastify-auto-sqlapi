# 0006. Raw DB errors surface as 500 — no SQLSTATE→HTTP mapping

- **Status**: accepted on the mapping; message exposure narrowed by
  [0013](./0013-sanitized-db-errors.md)
- **Date**: 2026-07-23 (confirmed by the maintainer in June 2026)

## Context

Constraint violations (unique, foreign key, not-null) bubble up from the driver and reach
the client as a `500` carrying the raw database message. A review proposed mapping
SQLSTATE codes to HTTP semantics — unique violation → `409`, FK/not-null violation →
`400` — with sanitized messages.

## Decision

No SQLSTATE mapping in the engine. Errors the plugin itself detects (validation, missing
PK, not found, tenant violations) throw proper `4xx` via `httpError`; everything coming
from the database is passed through unmapped.

## Alternatives considered

- **SQLSTATE→HTTP mapping layer** — rejected: the mapping is dialect-specific
  (PostgreSQL SQLSTATE vs MySQL errno), inevitably partial, and encodes product decisions
  (is a duplicate a conflict to surface or an internal bug?) the plugin should not make.
- **Sanitizing DB messages** — rejected as a plugin default: hiding details is an
  environment policy, and Fastify already gives consumers the hook for it.

## Consequences

- Constraint violations look like server errors (`500`) to API clients, and driver
  messages may leak schema details (table/column/constraint names). Consumers who care
  set a Fastify `setErrorHandler` — one place, their policy, their status codes.
- A consumer-facing "friendly duplicate error" is expected to be handled in `validate`
  (explicit pre-check) or in the consumer's error handler, not by the engine guessing
  intent from SQLSTATE.
