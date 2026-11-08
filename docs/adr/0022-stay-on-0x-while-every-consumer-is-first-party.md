# 0022. Stay on 0.x while every consumer is first-party — a breaking change bumps the minor, never the patch

- **Status**: accepted
- **Date**: 2026-11-08

## Context

The TypeBox 1.x migration raised the question of releasing it as 1.0.0 instead of 0.6.0,
lining the package up with its dependency's own 1.0.

The history argues both ways. Twelve breaking changes landed between 0.1.3 and 0.6.0, at
least one in every release since 0.2.0, on a two-to-four-week cadence. Grouped by kind:

| Kind | Breaking changes | Last one |
|---|---|---|
| API shape (names, request/response, URLs) | join redesign, route URL = `DbTables` key | 0.3.0 |
| Stricter defaults, security | `?` placeholders, composite PKs, unknown filter keys, request limits, tenant per request, `beforeInsert` on secondaries, verified upsert key | 0.4.0 |
| Correctness | NULL `min`/`max`/`avg` without children | 0.4.1 |
| Platform | Node.js 22, TypeBox 1.x | 0.6.0 |

The shape of the API has not moved since 0.3.0; its behaviour still tightens, mostly on
tenant isolation and mass assignment, where each new finding is likely to break someone.
Platform floors (Node.js, TypeBox, Fastify) will keep moving whatever the version number.

Every consumer today is a project of the maintainer, some of them applications run for
clients in production. Nobody outside picks the package by reading its version, and every
upgrade across a breaking change is done by the same person who wrote the change.

One release did not hold the line that makes `^0.x` ranges safe: **0.4.1 shipped a breaking
change in a patch** (the NULL aggregates). An `npm update` on a client application pinned to
`^0.4.0` would have taken it without anyone choosing to.

## Decision

**1. The package stays on 0.x** while every consumer is first-party.

**2. A release with a breaking change bumps the minor; a release without one bumps the
patch.** No exception for "small" breaks, correctness fixes that change results, or security
tightenings: if it needs a `BREAKING_CHANGES.md` entry, it is a minor. This makes a `^0.N.0`
range mean exactly "no breaking change", which is what an application in production needs
from `npm update`.

**3. A line still in use gets its security fixes as patches.** When a fix must reach an
application that has not moved to the newest minor, it is released as `0.N.x` from a
`release/0.N` branch cut at the `v0.N.*` tag, instead of forcing the upgrade.

**4. 1.0.0 is released when either of these happens first:**

- a consumer the maintainer does not control appears, or the package is promoted publicly;
- three consecutive releases, spanning at least two months, add no entry to
  `BREAKING_CHANGES.md`.

**5. 1.0.0 ships with its contract written down**, in an ADR that supersedes this one:

- what is public: the exports of `src/index.ts`, the HTTP request and response shapes, the
  manifest format; everything else is internal;
- a deprecation policy: a change to the API shape is announced (deprecated and warned about)
  at least one major before it is removed;
- security tightenings ship as a major with a migration guide, without waiting for a
  deprecation cycle;
- platform floors (Node.js, TypeBox, Fastify) move only in a major.

## Alternatives considered

- **1.0.0 now, with the TypeBox migration.** The version would promise stability nobody is
  there to rely on, and at the current pace of breaking changes the major would climb every
  few weeks until it stopped carrying information.
- **1.0.0 now, with frequent majors as Fastify does.** Viable mechanically, since every break
  already has a migration guide. It buys nothing while the maintainer upgrades every consumer
  personally, and it commits early to a deprecation discipline designed for consumers who do
  not exist yet.
- **Stay on 0.x with no exit criterion.** The 0.x signal would outlive the reason for it; when
  the first external user arrives, the decision would be taken under pressure instead of by a
  rule written in advance.
- **Keep allowing breaking changes in patches when they are fixes.** That is what 0.4.1 did.
  It makes every `npm update` a potential break for client applications, which is the one
  guarantee they need.

## Consequences

- Every breaking change still costs a manual bump in each project (`^0.6.0` → `^0.7.0`) and a
  read of `BREAKING_CHANGES.md`. Accepted: that review is the point.
- A fix that changes results, however small, waits for the next minor or becomes one. The
  release cadence makes that cheap.
- Client applications should commit their lockfile and use a `^0.N.0` range (or an exact
  version): with rule 2 both mean "no surprise breaks".
- The package keeps the 0.x signal, which discourages adoption. Accepted while adoption is
  not a goal; rule 4 says when it becomes one.
