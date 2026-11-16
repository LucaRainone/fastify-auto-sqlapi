# 0030. A child row is validated by its own table — a write join runs the child's `validate`

- **Status**: accepted — supersedes the `validate` row of [0014](./0014-what-follows-a-write-join.md)
- **Date**: 2026-11-16

## Context

ADR 0014 decided what a write join runs on a child row: the child table's transforms
(`insertExclude`, `beforeInsert`, `tenantScope`), not its verdicts (`validate`, `afterInsert`).
It rejected running the child's `validate` *"for now, not on principle"*: it would have made a
host's write start failing on child rows accepted the day before, for consumers that never
opted in.

That cost was real while 0.x consumers were upgrading minor by minor. Before 1.0 is published
it is not: every consumer migrates once (ADR 0027), and a rule that changes behavior is
cheapest now.

Meanwhile the gap has a cost of its own. A consumer avoids write joins for its link tables
precisely because a child row written through one skips its table's `validate`: the rules
`article_info` enforces on `POST /rest/article_info` do not hold when the same row arrives
under `upsert.info` of `POST /rest/article`. So the rule has to be written twice — once on the
child, once in the host's `validate` — or the consumer gives up the write join, and with it
`replace` (ADR 0029) and the atomic write.

The same consumer gave a second reason, that the child's `beforeInsert` did not see the FK to
the main row. That one is already fixed, within 0014: the FK is filled in before the hook, and
again after it, so it still always wins.

## Decision

**A write join runs the child table's `validate` on every child row it writes** — those of
`upsert` and of `replace`, not those of `delete`, which removes rows and renders no verdict on
them.

- **It runs before any SQL, after the host's `validate`.** A 400 writes nothing, as for every
  other validation; every child row is checked and all their errors answered together.
- **The child's `validate` receives the child row as `main`**, camelCase, as the request sent
  it, with the FK to the main row filled in when the main row's key is in the request — an
  update, or an insert naming its key — and absent when the database generates it.
- **It also receives `parent: { alias, main }`**: the alias the row was sent under and the main
  row of the request, as sent. `parent` is absent on the table's own routes, so it is both data
  — a rule on the parent's fields needs no FK and no query — and the signal that the row is a
  child, whose FK the engine fills in.
- **Its paths are re-rooted into the request.** The child returns paths of its own grammar
  (`main.title`, or `''`); the engine answers them at `upsert.info.0.title` (`replace.…` for a
  replace, `<item>.upsert.…` in a bulk upsert, `upsert.info.0` for `''`). Any other path is the
  hook's programming error, a 500 naming it, as a malformed `validate` result already is.
- **When the child declares `validateBulk`, it replaces the per-row `validate`**, called once
  per alias and main row with the rows as `items` and the same `parent` — the rule of ADR 0025,
  one level down. Its `items.<j>.main.<field>` paths are re-rooted the same way.
- **The child's `afterInsert` still does not run.** It fires side effects; running N of them
  inside the host's transaction, unordered against the host's own `afterInsert`, is the
  decision 0014 rejected and nothing here changes it.

A child row then goes through the single-insert pipeline of ADR 0005, with the FK the engine's:
`validate` on the row as sent, before any SQL; then, at write time, the `insertExclude` strip,
the FK fill, `beforeInsert`, the FK fill again, `tenantScope`, the write.

### The FK on an insert with a generated parent key — accepted, with examples

On `POST /rest/article` with a database-generated `id`, the article does not exist when the
child's `validate` runs, so `main.articleId` is absent. In practice:

```ts
// article_info.validate
validate: async ({ db, main, parent }) => {
  const errors: ValidatorResult = [];
  // 1. Input rules: hold everywhere, the FK is not involved.
  if (!main.title) errors.push({ path: 'main.title', code: 'required' });
  // 2. The FK is required on the table's own routes; as a child, the engine fills it in.
  if (!parent && !main.articleId) errors.push({ path: 'main.articleId', code: 'required' });
  // 3. A rule querying the parent's rows: absent FK means a new article, which has none yet.
  if (main.articleId && await slugTaken(db, main)) errors.push({ path: 'main.slug', code: 'duplicate' });
  // 4. A rule on the parent's fields: `parent` carries them, no FK needed.
  if (parent?.main.status === 'published' && !main.summary) errors.push({ path: 'main.summary', code: 'required' });
  return errors;
},
```

- Input rules (1) and rules on the parent's fields (4) work on every path.
- A required FK (2) is the one rule that would fail a correct request; `parent` tells the child
  it is one.
- A rule that reads the parent's existing rows (3) has nothing to read when the parent is new:
  skipping it without the FK is the right answer. A conflict between rows of the same request
  is the host's `validate`'s, or the child's `validateBulk`'s, which see them all.

## Alternatives considered

- **Keep 0014 as is.** The host's `validate` already receives the child rows; a rule can be
  written there. But it must be written once per host, and the table that owns the data is not
  the one that guards it — the same misplacement 0014 rejected for `beforeSecondaryInsert`.
- **Run the child's `validate` inside the transaction, after the main row is written**, so the
  FK is always known. A 400 would roll back and still write nothing on insert and update — but
  not in a bulk upsert, whose main rows are written by one statement outside any transaction
  (ADR 0003): a child's 400 would leave them written. Validation before any SQL is the one rule
  that holds on every path, and the FK it cannot see is the FK nothing needs yet.
- **No `parent`; a child checks `main.articleId` and lives with the false 400.** It forces a
  table to choose between guarding its own routes and accepting its rows as a child.
- **A flag instead of `parent`** (`ctx.asChild: true`). It says the row is a child but not
  whose; `parent` says both, under one name.
- **An opt-in on the relation or the table** (`validateAsChild`). A second way for a table's
  rule to apply or not, decided away from the rule; a consumer forgetting it keeps today's gap.
- **Run `afterInsert` too, for symmetry.** Rejected by 0014 for its side effects and ordering;
  `validate` has neither.

## Consequences

- A rule declared on a table holds wherever its rows are written: its own routes, a write join,
  a bulk upsert.
- A host's write can fail with a 400 at `upsert.<alias>.<i>.<field>` raised by the child's
  table; clients already handle those paths.
- A child `validate` that checks the FK as required must guard it with `!parent`, or it refuses
  correct writes through the parent.
- A child `validate` that queries the database runs once per child row; a table expecting many
  rows per write declares `validateBulk`.
- `ValidateContext` and `BulkValidateContext` gain `parent?: { alias, main }`; the glossary
  names it.
