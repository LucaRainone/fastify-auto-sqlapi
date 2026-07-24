# 0007. Table generation is explicit — `--all` is a migration helper, not the default

- **Status**: accepted
- **Date**: 2026-07-23

## Context

`sqlapi-generate-schema` with no arguments introspects every table, while
`sqlapi-generate-tables` with no arguments prints usage and exits, requiring `--all` or
explicit table names. A review flagged the opposite defaults as an inconsistency to
harmonize.

## Decision

The asymmetry is deliberate and stays. The two generators have different roles:

- **Schemas** are disposable mirrors of the database — regenerating all of them is always
  correct, so "all" is the natural default.
- **Table files are the consumer's working set**: which tables become API endpoints is a
  deliberate choice, and it is legitimate to keep tables out of `DbTables`. The intended
  flow is *"I added a table, I generate its Table file explicitly"*
  (`sqlapi-generate-tables customer`). If the default were "all", every run would
  resurrect Table files the consumer had deliberately deleted, forcing them to delete the
  same files again and again. `--all` exists only as a bootstrap helper when introducing
  the plugin into an existing codebase.

## Alternatives considered

- **Default to `--all` (mirror generate-schema)** — rejected: re-creates deleted Table
  files on every run, fighting the consumer's curation of the exposed surface.
- **Tracking deleted tables** (a skip-list) — rejected: state to maintain for a problem
  explicit invocation solves for free.

## Consequences

- `sqlapi-generate-tables` keeps requiring `--all` or table names; running it bare prints
  usage and exits non-zero.
- The generator never overwrites existing Table files, so both the explicit and the
  `--all` flow are safe to re-run.
