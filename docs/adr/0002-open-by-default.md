# 0002. Open by default — no imposed auth model

- **Status**: accepted
- **Date**: 2026-07-23 (confirmed by the maintainer in June 2026)

## Context

Registering the plugin with no configuration exposes every operation (read and write,
including bulk delete) on every table in `DbTables`. Security reviews repeatedly flag this
as a vulnerability and propose secure-by-default behavior: routes disabled until
explicitly enabled, or a mandatory auth hook.

## Decision

The plugin stays open by default. Authentication and authorization are the consumer's
job, wired through the tools provided for it: `onRequests` (global or per-table request
hooks), `operations` (per-table whitelist of registered routes), and `tenantScope`
(tenant isolation). The README carries a prominent warning in its Security section.

## Alternatives considered

- **Deny-by-default routes** (`operations` required, empty = nothing exposed) — rejected:
  it turns the five-minute quick start into configuration boilerplate, and the plugin's
  primary use case is rapid internal API scaffolding where the consumer adds auth at the
  Fastify level anyway.
- **Mandatory auth callback** (refuse to register without an `onRequests`) — rejected:
  imposes an auth model on consumers who legitimately handle auth outside the plugin
  (gateway, network isolation, Fastify-level hooks on the parent scope).

## Consequences

- **You must lock it down before exposing it.** The responsibility is documented, not
  enforced.
- Security reviews will keep flagging this; the answer is this ADR plus the README
  Security section, not a behavior change.
- `operations` gates HTTP routes only — the programmatic `sqlApi.*` methods remain
  available to consumer code, by design.
