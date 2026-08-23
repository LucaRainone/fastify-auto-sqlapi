# 0014. A secondary runs the child table's transform, not its verdicts

- **Status**: accepted
- **Date**: 2026-08-23

## Context

[ADR 0010](./0010-joins-do-not-run-route-guards.md) drew the line for reads: route-level
controls (`onRequests`, `operations`) do not follow a join, configuration-level ones
(`readExclude`, `tenantScope`, the relation's schema) do. The write side never had that line
drawn, and it had drifted into an inconsistent middle.

`processSecondaries` already consulted the child's configuration for two things — it stripped
the child's `excludeFromCreation` and enforced the child's `tenantScope` — while its
`beforeInsert` was silently skipped. The gap was invisible until a table started using that
hook to change a value's *representation* rather than to add a value: a column encrypted on
the way in was stored as ciphertext through `POST /rest/patient`, and as plaintext through
`POST /rest/visit` with the same row sent under `secondaries.patient`. Nothing failed; the
data was simply wrong in a way only a later read would show, and `afterRead` would then
"decrypt" a value that was never encrypted.

The reverse extension is not obviously right either. `validate` and `afterInsert` are also
per-table configuration, and running them for children would be the symmetric move — but they
do not transform a record, they *decide* about it: `validate` rejects the request, and
`afterInsert` fires side effects. Both would change when and how a host's write fails, for
consumers that never opted in.

## Decision

**A secondary is a write like any other for everything that shapes the record, and not for
anything that renders a verdict on it.** The child's configuration is applied in this order,
mirroring the single-insert pipeline of [ADR 0005](./0005-insert-pipeline-sanitize-before-hooks.md):

1. the child's `excludeFromCreation` strip (client-input whitelist);
2. the child's `beforeInsert` (may mutate, including on excluded fields);
3. conversion to DB column format;
4. the engine's FK auto-fill, which is authoritative over both the payload and the hook;
5. the child's `tenantScope` enforcement.

The child's `validate`, `validateBulk`, `afterInsert`, `beforeDelete` and `afterDelete` do not
run. `processDeletions` is unchanged: it removes rows, it does not shape them.

| Child-table config | Applies to a secondary |
|---|---|
| `excludeFromCreation` | yes |
| `beforeInsert` | yes |
| `tenantScope` | yes |
| `upsertMap` | yes (via the host's `upsertMap`) |
| `validate` / `validateBulk` | no |
| `afterInsert` | no |
| `onRequests` / `operations` | no (ADR 0010) |

The host's own `validate` receives the secondaries and is the place to reject them.

## Alternatives considered

- **Leave `beforeInsert` skipped and document it** — rejected: the failure is silent and
  writes bad data. A hook that assigns `createdBy` merely produced a null column when skipped;
  a hook that encodes a value produced a row that reads back as garbage, and no error marks
  the moment it happened.
- **Run the child's full pipeline (`validate` + `afterInsert`)** — rejected for now, not on
  principle. `validate` would make a host's insert start failing on child rows that were
  accepted the day before, and `afterInsert` would fire N side effects inside the host's
  transaction with no ordering contract against the host's own `afterInsert`. Both are
  behaviour changes that need their own decision; the host's `validate` already receives the
  secondaries.
- **A separate `beforeSecondaryInsert` hook on the host** — rejected: a second name for
  "prepare a row of this table", declared on the wrong table. The transform belongs to the
  table that owns the column, which is the same rule `afterRead` follows on the read side.
- **Run the child hook before the exclusion strip** — rejected: it inverts ADR 0005 and lets
  a client value survive on an excluded field.

## Consequences

- Behaviour change (CHANGELOG + BREAKING_CHANGES): a child table's `beforeInsert` now runs for
  rows written as secondaries, where it was silently skipped. A hook that was written assuming
  it only ever saw the table's own route — one that reads `req.params`, or increments a counter
  per call — now runs in a context it did not expect.
- The hook receives the **transaction** connection, not the pool: what it writes rolls back
  with the host's write.
- `beforeInsert` is now the one place where "how this table's rows are shaped on the way in"
  is written, on both entry paths — the dual of `afterRead` on the way out.
- The asymmetry between transform and verdict is now a stated boundary, so the next reader
  finds a decision instead of what looks like the same oversight in a different hook.
