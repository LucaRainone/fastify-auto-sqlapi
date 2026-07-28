# 0009. Schema exclusion is a config blacklist — excluded schemas are removed as orphans

- **Status**: accepted
- **Date**: 2026-07-27

## Context

`sqlapi-generate-schema` regenerates every table by default (ADR 0007: schemas are
disposable mirrors). There was no way to keep unwanted tables — migration bookkeeping
(`knex_migrations*`), PostGIS internals (`spatial_ref_sys`), vendor tables — out of the
generated schemas short of deleting the files after every run.

## Decision

A blacklist lives in the existing config file: `excludeTables: string[]` in
`sqlapi.config.ts`, matched against the DB table name, with `*` as the only wildcard.

Excluded tables are **invisible to the generator**: their schemas are not generated, and a
previously generated `Schema*.ts` for an excluded table is removed by the orphan cleanup
on the next full run — exactly as if the table had been dropped. This keeps the ADR 0007
invariant intact: everything under `schemas/` is a disposable mirror; excluding a table
must not turn its schema file into a hand-maintained exception.

This does not contradict ADR 0007's rejection of a skip-list for *tables*: there, explicit
invocation solves exclusion for free. For schemas the default is "all", so a blacklist is
the only way to exclude — and the same ADR is why `excludeTables` does **not** apply to
`sqlapi-generate-tables`.

## Alternatives considered

- **`.schemaignore` file next to the schemas** — rejected: a second config format and a
  second source of truth to parse and document, when a typed config file already exists.
- **CLI-only `--exclude` flag** — rejected as the primary mechanism: the exclusion is a
  durable property of the project, not of one invocation; forgetting the flag once would
  resurrect the unwanted schemas.
- **Keeping excluded schema files on disk (generator "never touches" them)** — rejected:
  it would silently support hand-maintained files under `schemas/`, breaking the "always
  safe to regenerate everything" property of ADR 0007.

## Consequences

- Adding a table to `excludeTables` deletes its generated schema file on the next full
  run. This is intended: excluded means gone, not frozen.
- Hand-written schemas do not belong in `schemas/`; exclusion is not a mechanism to
  protect local edits.
- An invalid `excludeTables` value (not an array of strings) fails the run with an
  explicit error rather than being silently ignored.
