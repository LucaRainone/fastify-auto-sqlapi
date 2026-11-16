# Architecture Decision Records

Deliberate design decisions of `fastify-auto-sqlapi`, with their rationale and the
alternatives that were considered and rejected.

**If you are an agent or a contributor about to "fix" one of the behaviors below: read the
matching ADR first.** These are not gaps or oversights — proposals that re-litigate a
decision recorded here should either reference new arguments the ADR does not address, or
be dropped.

ADRs are immutable: a decision is changed by adding a new ADR that supersedes the old one,
not by editing history.

## Index

| # | Decision |
|---|----------|
| [0001](./0001-no-orm-raw-sql.md) | No ORM — raw SQL with minimal dependencies |
| [0002](./0002-open-by-default.md) | Open by default — no imposed auth model |
| [0003](./0003-bulk-not-transactional.md) | Bulk operations are not transactional |
| [0004](./0004-updates-always-open.md) | Updates are always open — no `excludeFromUpdate` |
| [0005](./0005-insert-pipeline-sanitize-before-hooks.md) | Insert pipeline: client payload sanitized before `beforeInsert` |
| [0006](./0006-raw-db-errors.md) | Raw DB errors surface as 500 — no SQLSTATE→HTTP mapping |
| [0007](./0007-explicit-table-generation.md) | Table generation is explicit — `--all` is a migration helper, not the default |
| [0008](./0008-agent-client-interface.md) | Agent client interface: static grammar + runtime manifest |
| [0009](./0009-schema-exclusion-config-blacklist.md) | Schema exclusion is a config blacklist — excluded schemas are removed as orphans |
| [0010](./0010-joins-do-not-run-route-guards.md) | A declared join is a read grant — joins do not run the target table's route guards |
| [0011](./0011-join-fields-allowlist.md) | Per-relation field restriction is an allowlist, not a blocklist |
| [0012](./0012-anti-duplication-tooling.md) | Repository rules are enforced by executable gates, not by documentation |
| [0013](./0013-sanitized-db-errors.md) | Database error messages are sanitized on the wire by default (narrows 0006) |
| [0014](./0014-what-follows-a-write-join.md) | A secondary runs the child table's transform, not its verdicts (its `validate` row superseded by 0030) |
| [0015](./0015-non-writable-columns.md) | A column the database computes is not writable — `writeExclude` (narrows 0004) |
| [0016](./0016-a-view-is-a-table-config.md) | A view is a table config — the generator refuses to invent its primary key |
| [0017](./0017-the-schema-is-the-contract.md) | The database schema is the API contract — by default, and only by default |
| [0018](./0018-one-seam-to-the-http-framework.md) | The HTTP framework is reachable through one seam — `ApiRequest` |
| [0019](./0019-column-exclusion-is-generation-time-config.md) | Removing a column from the API is generation-time config — `excludeColumns`, never a Schema edit |
| [0020](./0020-no-conditional-or-mass-update-route.md) | No conditional or mass update route — a predicate write is a custom route |
| [0021](./0021-upsert-targets-a-verified-unique-key.md) | An upsert targets a unique key verified at startup — MySQL and MariaDB upsert by key, not by `ON DUPLICATE KEY` |
| [0022](./0022-stay-on-0x-while-every-consumer-is-first-party.md) | Stay on 0.x while every consumer is first-party — a breaking change bumps the minor, never the patch (superseded by 0027) |
| [0023](./0023-a-write-runs-in-a-transaction-or-not-at-all.md) | A write runs in a transaction or not at all — `withTransaction` requires `connect()` (narrows 0003's context) |
| [0024](./0024-the-consumer-maps-driver-codes-through-dberrors.md) | The consumer maps driver error codes through `dbErrors` — the plugin ships no mapping (narrows 0006, 0013) |
| [0025](./0025-validatebulk-replaces-validate-in-a-bulk-upsert.md) | `validateBulk` replaces `validate` in a bulk upsert — one call for the batch, not one per item |
| [0026](./0026-update-carries-its-primary-key-in-main.md) | An update carries its primary key in `main` — `PUT /rest/:table` has no `:id` |
| [0027](./0027-the-1-0-contract.md) | The 1.0 contract — what is public, how it changes, and the rules the API keeps (supersedes 0022) |
| [0028](./0028-select-star-is-the-default-projection.md) | `'*'` in `select` is the default projection — a computed field is asked for without copying the readable set |
| [0029](./0029-a-write-names-its-child-rows-by-action.md) | A write names its child rows by action — `upsert`, `delete`, `replace` — and answers with what happened (narrows 0003 for one item's children) |
| [0030](./0030-a-child-row-is-validated-by-its-own-table.md) | A child row is validated by its own table — a write join runs the child's `validate`, with `parent` (supersedes part of 0014) |

## When to write one

Only when a decision was genuinely debated, or is counter-intuitive enough that a reasonable
outsider would mistake it for a bug. Plain conventions belong in [AGENTS.md](../../AGENTS.md)
for consumers, or in `CLAUDE.md` at the repository root for contributors.

## Format

```markdown
# NNNN. Title (imperative statement of the decision)

- **Status**: accepted | superseded by NNNN
- **Date**: YYYY-MM-DD

## Context
What problem or tension forced a choice.

## Decision
What was decided, stated plainly.

## Alternatives considered
Each rejected option and the reason it lost.

## Consequences
What follows — including the costs accepted knowingly.
```
