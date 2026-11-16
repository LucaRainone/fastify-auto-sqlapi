# 0029. A write names its child rows by action — `upsert`, `delete`, `replace` — and answers with what happened

- **Status**: accepted (narrows the scope of [0003](./0003-bulk-not-transactional.md) for one item's children)
- **Date**: 2026-11-16

## Context

A write join writes child rows next to the main row. Through 1.0's development the request
named them `secondaries` (rows to write) and `deletions` (rows to delete), the same nouns the
response used for what was written and removed.

To set the tags of a post to exactly `{ 3 }`, a client had to know which tags the post has
now and send the difference: tag 3 under `secondaries`, the others under `deletions`. That is a
read before every write, and a race between the two. For many relations the request does
hold the whole set — the tags of a post, the members of a group, the translations of a
product — and a consumer migrating to 1.0 asked for it, atomic with the audit row its
after-hook writes.

Two shapes were tried before this one:

- **`replace: true` on the relation.** `secondaries` silently meant "the complete set" for that
  alias: the meaning of a request lived in a server config the client cannot see, adding a
  single row became impossible without sending them all, and `deletions` had to be refused for
  the alias.
- **A third request key next to `secondaries` and `deletions`.** It removed the ambiguity, but
  read as two nouns and a verb: `secondaries` names rows, not what to do with them.

## Decision

**A write request names its child rows in one section per action, by write alias:**

- `upsert` — write these rows: inserted, or upserted on the relation's `upsertKey`. The other
  child rows stay.
- `delete` — delete these rows, named by their key; the FK to the main row is filled in, so
  only children of this main row are reached. Update and bulk upsert only.
- `replace` — these are all the child rows: the rows sent are upserted on the relation's
  `upsertKey`, every other child row of the main row is deleted. `[]` deletes them all.

**The answer keeps nouns: `secondaries` for the rows written, `deletions` for the rows
removed** — in the response and in `afterInsert`/`afterUpdate`. The request says what to do,
the response what happened; a `replace` shows up in both.

`validate` and `validateBulk` receive the request's sections under the request's names
(`{ main, upsert, replace }`), because the paths they return point into the request
(`upsert.tags.0.tagId`).

The rules that follow:

- **`replace` needs the relation's `upsertKey`**: the key is what tells a child row the request
  sends from one it no longer does. Without one, `replace.<alias>` is a 400 `unknown_field`,
  and the request schema does not offer it.
- **An alias sits in one section.** In `replace` and in `upsert` or `delete` too, it is a 400
  `conflicting_alias` at `replace.<alias>`: the set already says what stays and what goes.
  Different aliases combine freely.
- **Upsert, then delete the rest — never delete everything and insert.** The rows that stay
  keep their identity, their generated columns and their own children, which deleting and
  re-inserting them would cascade to.
- **The child table's tenant guard joins the DELETE** (`buildTenantRowGuard`, as for `delete`):
  a child row of another tenant pointing at the same main row is never touched.
- **Insert and update run their child rows and after-hook in their transaction.**
- **A bulk upsert stays without a transaction (ADR 0003), but an item with a `replace` runs its
  child rows and `afterInsert` in a transaction of its own.** The batch is many operations,
  each with its own outcome; within one item, a replacement is one change and must not end
  half done. The item's main row is written by the batch's single statement before that, so it
  is outside the item's transaction.
- **`secondaries` and `deletions` in a request are a 400 `retired_key`** naming the section
  that replaced them (ADR 0027: refused, not ignored).

## Alternatives considered

- **`replace: true` on the relation.** One meaning per alias, decided by the server — but
  invisible in the request, and it took away the ability to add or remove a single row.
- **A request flag** (`replace: ['tags']` next to `secondaries`). The same key would mean "add"
  or "all of them" depending on another key, and a client forgetting the flag silently keeps
  rows it meant to drop.
- **`secondaries` / `deletions` / `replacements`.** Backward compatible, but the trio mixes a
  noun for rows with nouns for actions; the request keeps reading like a response.
- **Per-alias operations** (`secondaries: { tags: { add, remove, set } }`). Every alias would
  carry its own little grammar, and the error paths would grow a level; one section per action
  reads the same for every alias.
- **Delete every child row, then insert the ones sent.** It changes the identity of the rows
  that stay, resets their generated columns and cascades to their children; it also works
  without an `upsertKey`, hiding a relation whose rows cannot be told apart.
- **A transaction for the whole bulk upsert**, or none for an item either. The first is ADR
  0003's rejected option; the second leaves an item with the new rows written and the old ones
  still there, a state no request describes.

## Consequences

- A client sets a relation to an exact set in one request, without reading it first, and can
  still add or remove single rows with `upsert` and `delete`.
- Every 1.0 client renames `secondaries` to `upsert` and `deletions` to `delete` in its write
  bodies; the responses and the after-hooks are unchanged.
- The manifest gives each write join its `upsertKey`: present, the alias takes `replace`.
- A bulk upsert with `replace` items opens one transaction per such item, so it needs an
  adapter with `connect()` (ADR 0023) even though the batch itself has none.
