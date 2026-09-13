# 0019. Removing a column from the API is generation-time config — `excludeColumns`, never a Schema edit

- **Status**: accepted
- **Date**: 2026-09-13

## Context

[ADR 0017](./0017-the-schema-is-the-contract.md) lists one lever per way the exposed shape may
differ from the stored one. For *"a column must not exist for the API at all"* it said: trim it
out of the Schema. That lever did not exist. Schema files are disposable mirrors regenerated on
every run ([ADR 0007](./0007-explicit-table-generation.md), [ADR 0009](./0009-schema-exclusion-config-blacklist.md)),
so a trimmed Schema survived exactly until the next `sqlapi-generate-schema`. The two runtime
levers do not cover the case either: `readExclude` hides one side, `writeExclude` the other, and
`defineTable` refuses a field in both — because a column that is neither readable nor writable
still sits in the validation schema, the Swagger output and the manifest, where it is a lie.

## Decision

Column exclusion is a generation-time config, next to `excludeTables`: `excludeColumns:
string[]` in `sqlapi.config.ts`, entries of the form `"<table>.<column>"`, both parts matched
against the DB names with `*` as the only wildcard. A matched column is removed from the
generated Schema — its fields, its `colMap`, its `generatedFields` — so everything built from
the Schema (routes, filters, ordering, joins, Swagger, manifest, TypeScript types) is unaware of
it. There is nothing to hide at runtime because there is nothing there.

Two refusals, both loud at generation time:

- **A primary key column cannot be excluded.** Every route identifies rows with it; the table
  generator would either invent a key or write a placeholder, and either is silent damage.
- **A table cannot be left with no columns.** That is what `excludeTables` is for, and one
  mechanism per intent keeps the config readable.

`excludeColumns` runs after `excludeTables`, so a column pattern is never checked against a
table the generator will not see — a `*.id` glob does not trip on the primary key of a table
that is excluded anyway.

## Alternatives considered

- **Editing the generated Schema file** — the documented answer until now, rejected: the file
  is overwritten on every run, so the edit is a hand-maintained exception under `schemas/`,
  exactly what ADR 0009 refused to support for whole tables.
- **A runtime `exclude` key on `defineTable`** — rejected: the Schema is imported by the
  consumer's code before `defineTable` runs, so its TypeScript type, its `validation` object and
  the `$id`-registered JSON Schema would still carry the column. A runtime lever can only hide;
  the column would remain visible in Swagger, in the manifest and in the `TypeSchema` type, and
  every reader of those would have to know about the second layer.
- **Allowing `readExclude` + `writeExclude` on the same field** — rejected for the same reason:
  it is the runtime lever again, with the added cost of a rule that means "does not exist" but
  reads as two independent hidings.
- **A per-column option inside the Schema file** — rejected: the Schema file carries no config,
  by design; `sqlapi.config.ts` is where the generator's inputs already live.

## Consequences

- Adding an entry to `excludeColumns` changes the generated Schema on the next run and, for
  TypeScript consumers, fails compilation wherever the column was referenced. Intended: that is
  ADR 0017's "checked, not implied" at work.
- The relation-level narrowing described in [ADR 0010](./0010-joins-do-not-run-route-guards.md)
  — a relation declared with a narrower Schema object — is a different tool for a different
  scope (per relation, not per API) and is unaffected.
- An `excludeColumns` entry that is not `table.column`, that reaches a primary key, or that
  empties a table fails the run with an explicit error rather than being ignored.
