# 0027. The 1.0 contract — what is public, how it changes, and the rules the API keeps

- **Status**: accepted — supersedes [0022](./0022-stay-on-0x-while-every-consumer-is-first-party.md)
- **Date**: 2026-11-16

## Context

ADR 0022 kept the package on 0.x while every consumer was first-party, named two conditions
for 1.0, and required 1.0 to ship with its contract written down in an ADR superseding it.

On 2026-11-15 the maintainer chose to release 1.0 instead of 0.7, before either condition was
met. The reason was the API itself: a review found the same concept under several names
(`selection` and `select`, `allowedReadJoins` and `operations`), the same request in two
places (the search querystring and its body), two shapes for one result (`joinGroup` with and
without `by`, tuples and objects for a validation error), and internals exported as if they
were API. Fixing them one minor at a time would have broken every consumer once per minor;
fixing them together breaks them once, with one migration guide.

## Decision

**1. What is public.** Everything else is internal and may change in any release:

- the runtime exports of `src/index.ts`, pinned by `test/unit/public-exports.test.js`, and
  the types it exports;
- the HTTP routes, their request and response shapes, the error envelope and its `fields`
  codes, as AGENTS_FRONTEND.md describes them;
- the agent manifest format;
- the CLI: its commands, `sqlapi.config.ts` (`CliConfig`) and the shape of the files it
  generates.

**2. Semantic versioning.** A breaking change to the public surface is a major; a backward
compatible addition is a minor; a fix is a patch. A fix that changes results someone may rely
on is breaking (the 0.4.1 lesson of ADR 0022).

**3. How the public surface changes:**

- a change to the API shape is announced — deprecated, and warned about at runtime — at least
  one major before it is removed;
- a security tightening ships as a major with a migration guide, without waiting for a
  deprecation cycle;
- platform floors (Node.js, TypeBox, Fastify) move only in a major;
- a major line still in use gets its security fixes as patches, from a `release/N.x` branch.

**4. The rules 1.0 applied, which later changes keep:**

- **One name, one place.** A concept has one name (docs/GLOSSARY.md) and a value one place in
  a request: no alias, no second form of the same key.
- **Refused, not ignored.** A key the API no longer reads is rejected naming its replacement —
  a 400 `retired_key` in a request, an error at startup in a config — never dropped in silence.
- **Codes, not prose.** An error carries stable codes the client translates; the server writes
  no user-facing text, and a hook returns `{ path, code }`.
- **One way to mount the routes.** The plugin is registered, narrowed with `operations` when
  needed; route plugins, engines and schema builders are internals.
- **Configuration fails at startup.** A config the routes could not honour — an unverifiable
  upsert key, an unknown `defaultOrder` field, an ambiguous relation target — throws when the
  plugin is registered, not on the first request.

## Alternatives considered

- **Stay on 0.x and ship the cleanup across several minors**, as ADR 0022 prescribed. Each
  minor would break every consumer again, and the API would stay incoherent between them.
- **1.0 with the old names kept as deprecated aliases.** The aliases are the ambiguity 1.0
  removes; a deprecation cycle protects consumers the maintainer does not reach, and at the
  time of the release there were none.
- **1.0 without a written contract.** The version would promise stability without saying what
  is stable; the first change after 1.0 would be decided case by case.

## Consequences

- Every consumer migrates once, with BREAKING_CHANGES.md.
- After 1.0, a change to the API shape costs a major and a deprecation cycle; the cleanup it
  would have done must be worth that.
- The rules in point 4 bound future features: a new option that adds a second name for a
  concept, or a key that is silently ignored, contradicts this ADR and needs a new one.
