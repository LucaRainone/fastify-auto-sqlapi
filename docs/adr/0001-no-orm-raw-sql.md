# 0001. No ORM — raw SQL with minimal dependencies

- **Status**: accepted
- **Date**: 2026-07-23 (foundational decision, predates this record)

## Context

Auto-generating CRUD APIs from database tables is the territory of ORMs and heavy
API-builder frameworks. Adopting one would have provided models, migrations and query
building for free — at the price of a large dependency tree, an abstraction layer between
the consumer and their SQL, and lock-in to the ORM's schema model.

## Decision

The plugin talks to the database with raw SQL through thin driver adapters (`pg`,
`mysql2`), composing WHERE clauses with `node-condition-builder` and validating with
TypeBox. No ORM, no query-builder DSL, no migration system. Runtime dependencies are kept
to the minimum, and the plugin re-exports its building blocks (TypeBox, ConditionBuilder)
so consumers build on the same tools instead of adding parallel ones.

## Alternatives considered

- **Build on an ORM (Prisma, Drizzle, Sequelize, …)** — rejected: large dependency
  surface, a second schema definition to keep in sync with the DB, and the ORM's
  abstractions leak into the public API. The CLI introspection (`information_schema`)
  gives the same "schema from the DB" ergonomics without the layer.
- **Hand-rolled query-builder DSL** — rejected: reinvents an ORM incrementally.
  `node-condition-builder` covers the one genuinely composable part (conditions);
  everything else is plain SQL the maintainer can read and debug.

## Consequences

- The engine owns dialect differences (placeholders, quoting, RETURNING vs insertId)
  explicitly — see `src/lib/dialect.ts` and the adapters.
- Consumers get a framework approach: tools are provided (SqlApi, QueryClient,
  ConditionBuilder), product structure is not imposed.
- Features an ORM would give for free (migrations, lazy relations, identity maps) are
  intentionally out of scope.
