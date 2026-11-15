# 0026. An update carries its primary key in `main` — `PUT /rest/:table` has no `:id`

- **Status**: accepted
- **Date**: 2026-11-16

## Context

`GET /rest/:table/:id` and `DELETE /rest/:table/:id` name the row in the path. `PUT
/rest/:table` does not: the row is named by the primary key inside `main`, in the body. Read
next to each other, the routes look inconsistent, and the obvious fix is `PUT
/rest/:table/:id`.

The update body is not a bag of fields. It is `{ main, secondaries?, deletions? }`: the row,
the child rows written with it and the child rows removed with it, as one request (ADR 0014).
`sqlApi.update(table, { main, … })` takes the same body, and so does each item of a bulk upsert.

A primary key can be composite. `GET` and `DELETE` address a row by one value, so they do not
exist for a composite-PK table; an update does, matching every primary key column.

## Decision

**An update names its row by the primary key fields in `main`.** The route is `PUT
/rest/:table`; a missing key field is a 400 at `main.<field>`. The update matches all of them,
single or composite.

## Alternatives considered

- **`PUT /rest/:table/:id`, key in the path only.** Breaks composite keys, which do not fit one
  segment, and makes the HTTP body differ from `sqlApi.update` and from a bulk upsert item,
  which have no path.
- **Key in both the path and `main`.** Two places for one value: a request whose path and body
  disagree needs a rule for which one wins, and every client must keep them in sync.
- **Key in the path, with `main.id` refused.** Same composite-key problem, and `main` would no
  longer be the row it is everywhere else.

## Consequences

- The routes are asymmetric: `GET` and `DELETE` take `:id`, `PUT` does not. The route
  reference in AGENTS_FRONTEND.md says so (`main(+PK)`).
- One body shape for an update, whether it arrives over HTTP, through `sqlApi`, or as a bulk
  upsert item.
- An update never touches more than the row its full key names: there is no update by
  predicate (ADR 0020).
