# 0016. A view is a table config — the generator refuses to invent its primary key

- **Status**: accepted
- **Date**: 2026-08-28

## Context

Views were never designed for, and they worked anyway: both introspections read
`information_schema.columns`, which lists view columns exactly like table columns, so
`sqlapi-generate-schema` produced a Schema and searching the result worked with no special
support. Three things underneath that were wrong.

**The primary key was invented in silence.** A view carries no `PRIMARY KEY` constraint, so
`is_primary` is false on every column and the generated Schema had no `primaryKey`. The table
generator then fell through to its heuristic for hand-written schemas: `id` if present,
otherwise **the first integer column**, otherwise the first column of any kind. On
`SELECT status, count(*) AS order_count ... GROUP BY status` that hands back `order_count` — a
count — as the key, and `get/:id`, `update` and `delete` then address rows by it. Nothing said
so, in the file or on the console.

**Nothing validated `primary` at all.** `defineTable` checked `tenantScope`, `readExclude`,
`computedFields` and alias uniqueness, but a `primary` naming a field the schema does not have
passed straight through and became a raw SQL error on the first request — a 500, per
[ADR 0006](./0006-raw-db-errors.md).

**PostgreSQL materialized views were invisible.** They are not in `information_schema` at all;
they live only in `pg_catalog`. They were skipped without a word — and a materialized view is
precisely the kind of expensive read one wants to expose.

## Decision

A view **is** a table config. No `ViewName` file, no `View*` type, no `readOnly` flag: the
plugin has one concept for "a relation with columns you can query" and a view is that one. A
second name would fork the `dbTables` keys, the generator, the docs and the manifest to express
nothing the existing vocabulary cannot.

What changes is what may be **assumed**, and all of it lives in the generator and in startup
validation, not in the runtime semantics:

- Introspection reports `is_view` on both engines, and PostgreSQL materialized views are read
  from `pg_catalog` and reported the same way. The generated Schema carries `isView: true`.
- For a view the generator **never guesses a key from a column type**. It accepts `id` when the
  view has one — a strong enough signal — and says in the file that the key was *inferred, not
  read from the database*. With no `id`, it writes a `TODO_pick_a_unique_column` placeholder
  rather than a wrong answer.
- A view's generated config starts read-only: `operations: ['search', 'get']`, or
  `['search']` when the key is unresolved. `defaultOrder` names a real column, so search never
  falls back to the placeholder, and the config **works as generated** — the TODO is a note for
  whoever wants to widen it, not a defect.
- `defineTable` now validates `primary` against the schema fields. The exception is exact and
  narrow: a table exposing **only** `search` and naming its own `defaultOrder` never reads
  `primary`, so it is allowed. Anything else fails at startup.
- `sqlapi-generate-schema` prints the views it found and both assumptions it had to make. A
  generated source file is not always read; the output of the command that produced it is.

Writes through a view are **not** blocked at runtime. A view simple enough for the engine to
make updatable accepts INSERT and UPDATE on both PostgreSQL and MySQL, and using one as a
projection or permission layer is a legitimate pattern the plugin has no business refusing. The
read-only start is the *generated template* — a file the developer then owns — which is a
different thing from the runtime default that [ADR 0002](./0002-open-by-default.md) settles.
That default is untouched: a hand-written view config with no `operations` still exposes
everything.

## Alternatives considered

- **`ViewName` files / a distinct type** — rejected: it forks a concept for no expressive gain
  and breaks the one-name-per-concept rule the glossary exists to enforce.
- **A `readOnly: true` flag on `defineTable`** — rejected: a second spelling of
  `operations: ['search', 'get']`.
- **Blocking writes to views at runtime** — rejected: simple views are genuinely updatable on
  both engines (verified), and the plugin cannot tell which ones from the schema alone. It
  would remove a working feature to prevent an error the database already reports.
- **Keep guessing the key, just add a comment** — rejected: the wrong-key failure is silent and
  addresses *rows*, which is the worst kind. A placeholder that refuses to start is the loud
  version of the same information.
- **Skip views entirely, or leave materialized views unsupported and document it** — rejected:
  they already worked for reads, which is the case that matters, and silence about a relation
  the database has is the least defensible of the options.

## Consequences

- A view without an `id` column needs one manual edit before it can serve anything but
  `search`. That is the point: the edit is a decision about uniqueness that only the author of
  the view can make.
- `defineTable` now throws at startup on a `primary` that names no schema field. A config that
  relied on that tolerance — a primary key deliberately kept out of the Schema — has to name a
  schema field or restrict itself to `operations: ['search']`.
- Materialized views appear in generation runs where they did not before, so a project that
  regenerates with `--all` will find new `Table*.ts` files for them.
- The `is_view` flag is generator-facing. Nothing in the request path branches on it: a view
  searches, filters, orders, paginates, joins and (when the database allows) writes through the
  same code as a base table.
