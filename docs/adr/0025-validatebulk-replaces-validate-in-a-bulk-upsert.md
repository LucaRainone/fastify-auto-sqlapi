# 0025. `validateBulk` replaces `validate` in a bulk upsert — one call for the batch, not one per item

- **Status**: accepted
- **Date**: 2026-11-16

## Context

A table can declare two validators. `validate` checks one write: `{ main, secondaries }` of an
insert or an update. `validateBulk` checks a bulk upsert as a whole: `{ items }`, every item at
once, with paths starting at `items.<i>`.

Without `validateBulk`, a bulk upsert runs `validate` once per item. With it, the bulk upsert
calls `validateBulk` once, and `validate` does not run for any of its items. A reader who
declares both, and expects both to run, takes the second behavior for a bug: a rule written
only in `validate` is not enforced on `PUT /bulk/:table`.

The rules worth a validator are mostly the ones that ask the database: a code already taken, a
period overlapping an existing one, a parent in the wrong state. Run per item, each costs one
query per item: a thousand-item batch becomes a thousand round trips before anything is
written. Run over the batch, the same rule is one query (`WHERE code IN (…)`), and it can also
see what a per-item check cannot: two items of the same batch colliding with each other.

## Decision

**When a table declares `validateBulk`, a bulk upsert calls it once with every item, and does
not call `validate`.** When it does not, `validate` runs once per item, as for single writes.

`validateBulk` is the bulk counterpart of `validate`, not an addition to it: a rule that must
hold in bulk is written there too, in its batch form.

## Alternatives considered

- **Run both: `validateBulk` once, then `validate` per item.** Brings back the N+1 queries the
  batch validator exists to avoid, and reports the same problem twice when a rule is in both.
- **Warn at `defineTable` when both are declared.** Declaring both is the normal case — one for
  single writes, one for batches — so the warning would fire on every correct config.
- **Derive one from the other.** A batch rule is not a loop over the per-item rule (it sees
  collisions inside the batch, it queries once); a per-item rule cannot be lifted to a batch
  without knowing what it queries.

## Consequences

- A rule enforced on single writes but missing from `validateBulk` is not enforced on bulk
  upserts. AGENTS_BACKEND.md says so next to the declaration of `validateBulk`.
- A table without `validateBulk` keeps the simple behavior — `validate` per item — and its cost.
- Both return the same `{ path, code }` objects, so a client handles a bulk 400 as any other.
