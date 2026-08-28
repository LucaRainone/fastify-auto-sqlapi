# 0015. A column the database computes is not writable — `writeExclude` (narrows 0004)

- **Status**: accepted
- **Date**: 2026-08-28

## Context

[ADR 0004](./0004-updates-always-open.md) rejected `excludeFromUpdate`: a static per-field
write block, proposed to protect `isAdmin`, `createdAt` and ownership columns. It lost on one
argument — those cases are **session-dependent**, a static list cannot express them, and
offering one would give a false sense of security to consumers who used it for exactly that.
That reasoning stands unchanged.

It does not, however, cover a case the plugin met later: a column the database itself refuses
to be told about.

```sql
subtotal INTEGER GENERATED ALWAYS AS (qty * price) STORED
```

Both engines reject the whole statement — not the field — when a write so much as names such a
column: `428C9 cannot insert a non-DEFAULT value into column "subtotal"` on PostgreSQL,
`ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN` on MySQL. Yet nothing in the generated schema said
so, so the column was offered as an ordinary writable field, and a client that sent it back
what a read had just returned got a **500** — a raw driver error, per
[ADR 0006](./0006-raw-db-errors.md) — for a payload nobody could have made valid.

The same blind spot hid `GENERATED ... AS IDENTITY`, which has no `column_default` to reveal
that the database fills it in: the generated field came out mandatory and the table could not
be inserted into at all.

## Decision

Fields the database computes are excluded from every write path. The CLI records them in the
generated Schema's `generatedFields`, and the runtime removes them from the insert, update and
bulk-upsert bodies (main and secondaries) and again inside the engines, which `sqlApi.*`
reaches without those schemas.

`ITable.writeExclude` exposes the same mechanism for the columns introspection cannot know
about — one a trigger owns, one a migration is about to drop.

This narrows 0004 rather than reversing it, and the boundary is what the exclusion is *about*:

- **a fact about the column** — the database rejects the value whoever assigned it, so there is
  no configuration in which offering the field helps anyone. This ADR.
- **a rule about the caller** — who may change what, when. Still product logic, still
  `beforeUpdate` / `validate` / a dedicated endpoint. Still ADR 0004.

Three consequences follow from that boundary and are enforced:

- `writeExclude` runs **after** the write hooks — the opposite of `excludeFromCreation`, which
  is sanitized before them so a hook can assign the field ([ADR 0005](./0005-insert-pipeline-sanitize-before-hooks.md)).
  A hook cannot put back a value the database will refuse.
- `defineTable` rejects a field that is also in `readExclude`: neither readable nor writable is
  what removing it from the Schema means.
- `defineTable` rejects the primary key, which the update body needs to identify the row.

## Alternatives considered

- **`Schema.generatedFields` only, no public key** — rejected: it covers the introspected case
  and nothing else, and a consumer whose schema is hand-written or whose column is owned by a
  trigger would be back to a driver error with no way out.
- **Let the write through and map the driver error to a 400** — rejected: it contradicts
  [ADR 0006](./0006-raw-db-errors.md) (no SQLSTATE→HTTP mapping), it costs a round trip to the
  database to learn what the schema already knew, and the field would still be advertised as
  writable in Swagger and in the agent manifest.
- **Trim the column out of the generated Schema** — rejected: that removes it from reads too,
  and a computed column is precisely the one a client wants to read.
- **Reopen 0004 and add a general `excludeFromUpdate`** — rejected: the false-sense-of-security
  argument is untouched by anything here. The documentation for `writeExclude` says what it is
  not for, and the key deliberately has no per-caller or per-role dimension that would invite
  the misuse 0004 warned about.

## Consequences

- Under Fastify's default `removeAdditional: true`, a computed column in a write body is
  **stripped silently** rather than rejected; the row is written with the value the database
  computed. With `removeAdditional: false` the closed body schema answers 400. Either way the
  driver error is gone — which was the point.
- A consumer upgrading gets the fix from **regenerating the Schema files alone**: the exclusion
  travels in `generatedFields`, not in the `Table*.ts` the generator never overwrites.
- The generated `Table*.ts` names the computed columns in a comment and leaves `writeExclude`
  commented out, and `sqlapi-generate-schema` prints them per table — a generated source file
  is not always read, its command's output is.
- Reads are untouched: a computed column stays projected, filterable, orderable and
  aggregatable, because it is a real column with a real value.
