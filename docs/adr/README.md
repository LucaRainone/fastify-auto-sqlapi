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

## When to write one

Only when a decision was genuinely debated, or is counter-intuitive enough that a reasonable
outsider would mistake it for a bug. Plain conventions belong in [AGENTS.md](../../AGENTS.md).

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
