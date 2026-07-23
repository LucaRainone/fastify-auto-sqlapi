# 0004. Updates are always open — no `excludeFromUpdate`

- **Status**: accepted
- **Date**: 2026-07-23

## Context

`excludeFromCreation` strips client-supplied fields from inserts. A symmetric
`excludeFromUpdate` was proposed to statically block fields on the update path (e.g.
`createdAt`, `isAdmin`), partly to close the asymmetry where a field excluded from
creation can still be modified via `PUT`.

## Decision

No `excludeFromUpdate`. Every Schema field is updatable by default, and
`excludeFromCreation` is defined as an **ergonomics tool for creation** (auto-generated
PKs, DB-default columns — its original purpose was handling autoincrement validation),
**not** a field-level security mechanism.

Field-level update rules are product logic the plugin must not decide: a super admin may
legitimately fix an `updatedAt`; in one product users may move themselves across tenants,
in another an admin moves others, in a third nobody moves anyone. A static list cannot
express any of this — real authorization is contextual (session, role, record state).
Consumers encode their rules in `beforeUpdate` (silent strip) or `validate` (loud 400),
or move privileged transitions to dedicated endpoints and keep them off the auto routes
via `operations`.

## Alternatives considered

- **`excludeFromUpdate` list** — rejected: the main risk is the *false sense of
  security*. It only covers "nobody, ever, via API", while the dangerous real-world cases
  (`isAdmin`, roles, ownership) are session-dependent — someone would use the list for
  them and believe the problem solved.
- **`immutable: [...]` / per-field `writable` modes** — rejected: a bigger redesign of
  the write model for the same limited static semantics.

## Consequences

- Sensitive flags in the Schema are updatable through the auto routes until the consumer
  adds a hook. This is documented prominently (README Security → "Field-level update
  rules are product logic", AGENTS_BACKEND.md pattern "Protect sensitive fields on
  update").
- The tenant column is the one deliberate exception, and only under opt-in `tenantScope`:
  tenant-scoped callers cannot re-tenant records (isolation contract), while admin
  callers (`getTenantId` → `null`) remain unrestricted — consistent with "the plugin does
  not decide product rules".
