# 0005. Insert pipeline: client payload sanitized before `beforeInsert`

- **Status**: accepted
- **Date**: 2026-07-23

## Context

Until v0.1.9 the insert pipeline applied `excludeFromCreation` *after* the `beforeInsert`
hook, so a value the hook assigned to an excluded field was silently stripped from the
INSERT. This broke the documented server-generated-id pattern (TEXT PK in
`excludeFromCreation`, id generated in `beforeInsert` → not-null violation) and
contradicted the documented contract that hook mutations propagate to the SQL. The same
ordering flaw let an excluded FK column erase the engine's own FK auto-fill on secondary
records.

## Decision

Exclusion is a whitelist on **client input** and runs at the client boundary. The insert
pipeline order is, for both single insert and bulk upsert:

1. `validate` — receives the payload **as sent by the client** (documented contract);
2. `excludeFromCreation` strip;
3. `beforeInsert` — hook mutations, including on excluded fields, reach the SQL;
4. conversion to DB column format.

For secondary records, exclusion runs **before** the engine's FK auto-fill, so the
injected parent key always survives.

Server-side writers are ordered by trust: client input is sanitized first, then hooks
mutate freely, then engine-enforced values (tenant injection/validation) run last and
fail loudly on conflict rather than stripping silently.

## Alternatives considered

- **Strip after the hook** (previous behavior) — rejected: silently discards
  server-generated values; the only thing it "protected" was the ability of a hook to
  accidentally write an excluded field, which is server code and trusted.
- **Strip before `validate` too** — rejected: `validate` is documented to receive the
  record as sent by the client; changing its input would break that contract for no
  gain.

## Consequences

- The pattern `excludeFromCreation: ['id']` + id-generating `beforeInsert` works as
  documented; consumers no longer need the `schemaOverrides` workaround.
- Behavior change (noted in the CHANGELOG): a hook that assigns an excluded field now
  writes it, where it was previously discarded.
- `afterInsert` no longer sees client-supplied values on excluded fields — it sees what
  was actually written.
- Locked by unit tests (single, bulk, upsert, secondaries, validate-ordering) and by a
  dialect-parametric integration suite reproducing the original failure.
