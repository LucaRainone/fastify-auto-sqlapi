# 0011. Per-relation field restriction is an allowlist, not a blocklist

- **Status**: accepted
- **Date**: 2026-07-31

## Context

[ADR 0010](./0010-joins-do-not-run-route-guards.md) establishes that a declared join is a read
grant, and that the only thing narrowing what a relation exposes is the schema it was declared
with. The pattern it documented was to hand-write a trimmed copy:

```typescript
const SchemaUserPublic = { ...SchemaUser, fields: { id: SchemaUser.fields.id, name: SchemaUser.fields.name } };
```

That works, but the copy is derived state with nothing keeping it in sync. Schemas are
regenerated from the database as disposable mirrors (ADR 0007), so the copy silently drifts:
adding a column to `user` leaves `SchemaUserPublic` correct, dropping or renaming one leaves it
referencing a field that no longer exists, and neither shows up until a request fails.

The restriction belongs in the relation, where someone reading the table configuration is
already looking. The open question was its polarity.

## Decision

`buildRelation` takes `fields: string[]` — an **allowlist** of the target's fields reachable
through that relation. The relation is declared against a schema narrowed to that list, so every
existing check (`field in schema.fields`) enforces it without a parallel code path: `selection`,
`filters`, `conditions`, `orderBy`, aggregations, `aggregations.by`, and the generated request
and response schemas.

```typescript
buildRelation(SchemaAgent, 'userId', SchemaUser, 'id', { unique: true, fields: ['id', 'name'] })
```

Allowlist, not a `excludeFields` blocklist, because the failure modes are not symmetric. A
column added to the table later is not reachable through the relation until someone adds it —
the new column is invisible by default, and the cost of forgetting is a `400`. Under a blocklist
the same event silently widens every relation that did not anticipate it, and the cost of
forgetting is disclosure. On a join — a grant handed out under *another* table's authorization —
fail-closed is the only defensible default. It also reads the same way as `selection`, which is
already an allowlist.

Three rules follow from making it real rather than cosmetic:

- **It must include the join field.** That column is what correlates the fetched rows with the
  main ones; omitting it hands the caller rows it cannot match to anything. Rejected at
  declaration, like `readExclude` refusing to hide a primary key.
- **It is rejected on `allowedWriteJoins`.** Write paths resolve a secondary's upsert rule by
  looking its schema up in `upsertMap` **by identity**; a narrowed relation carries a copy, so
  the lookup would miss and the upsert would quietly degrade to a plain insert. The narrowed
  schema would also drop columns the caller legitimately sent.
- **Computed fields on the target resolve against the narrowed schema.** A computed field reads
  whatever columns it likes; resolving it against the full table schema would leave a documented
  way around the allowlist (`salaryBand` returning what `salary` says). One that stays inside the
  list keeps working; one that reaches outside is a `400`.

The default `selection: '*'` is spelled out into the allowed columns on a restricted relation.
It used to emit a real `SELECT *`, with the extra columns removed only by the response
serializer — which does not run for a caller of `sqlApi.search()`. An allowlist that leaks on its
default is not an allowlist.

## Alternatives considered

- **`excludeFields: string[]` (blocklist)** — rejected on the fail-open argument above. It is
  shorter to write when hiding one column out of twenty, and it would have read like
  `readExclude`; neither outweighs a new column defaulting to exposed.
- **`lockSelection: true`, making the declared `selection` a ceiling** — rejected: it caps the
  projection only. The excluded column stays reachable from `filters`, `conditions` and
  `orderBy`, which is the bisection leak `readExclude` exists to prevent — a guard that hides a
  value from the output while leaving it interrogable is worse than none, because it reads as
  protection.
- **Making the relation's `selection` a ceiling instead of adding a field** — rejected in
  ADR 0010: breaking, and still static.
- **Threading the allowlist through every validation site instead of narrowing the schema** —
  rejected: it would leave each new read surface to remember the check. Narrowing the schema is
  closed by construction, which is the property that made the hand-written trimmed copy work in
  the first place.
- **Keeping the hand-written trimmed copy as the documented pattern** — rejected: it duplicates
  regenerated state. It still works, and is the way out if a relation needs a shape `fields`
  cannot express.

## Consequences

- `fields` restricts **reading** only. It is not a substitute for `readExclude`, which hides a
  column from the owning table's own routes too, nor for `onRequests`, which is what decides who
  may call them.
- It is static, like everything else that crosses a join. Role-dependent column visibility —
  admins seeing `email`, nobody else — still has no mechanism; the candidate remains a
  request-resolved `readExclude`, unaffected by this ADR.
- A relation and its write counterpart can no longer be the same `buildRelation` call when the
  read side is restricted. Declaring two is the intended answer, not a workaround.
- The generated agent manifest still describes join targets by table name only, so an LLM client
  reading it may ask for a field the relation does not expose and get a `400`. Listing a
  restricted relation's fields in the manifest is a follow-up.
