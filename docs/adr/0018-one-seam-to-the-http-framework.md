# 0018. The HTTP framework is reachable through one seam — `ApiRequest`

- **Status**: accepted
- **Date**: 2026-08-29

## Context

The question was what it would take to serve the same engine over something other than Fastify.
Measuring first turned up a codebase that was already almost free of one:

- of 74 files under `src/`, 26 named a Fastify type and **not one imported a value from it**;
- **nothing under `src/lib/` ever read a property off the request** — no `body`, no `params`, no
  `log`. It arrives from the route, is forwarded to `getTenantId`, `validate` and the hooks, and
  is otherwise untouched;
- `httpError` produces a plain `Error` carrying `statusCode`. Fastify happens to read that; the
  plugin does not produce it *for* Fastify.

So the engine, the schema builders and the write pipeline depend on a web framework for exactly
one thing: the **name of a type they never dereference**. That dependency was spread across
thirteen files, where every new hook signature quietly widened it, and nothing prevented an
engine from starting to read `request.headers` tomorrow.

## Decision

The request type is declared once, in `src/types/request.ts`, and everything in the core refers
to that name:

```ts
export type ApiRequest = FastifyRequest;
```

`.dependency-cruiser.mjs` enforces it: `http-framework-behind-one-seam` fails the build on a
`fastify` import — **including a type-only one** — anywhere under `src/lib/`, `src/types/` or
`src/bin/` other than that file. The two Fastify bridge helpers that lived in `lib/`
(`setup-swagger`, `sql-api-decorator`) moved to `src/routes/`, which is where the adapter is, so
the rule needs no exceptions.

A plain alias, not a generic parameter on `ITable`. `ITable` appears as a bare type in over a
hundred places; threading `<Req>` through all of them — and through `DbTables`, and every
`*Params` — changes the public type surface today to buy a property that only pays off once the
core ships as a package of its own. The alias makes the seam **one file**, which is the whole
requirement, and leaves the generic available later without having spent anything on it now.

This decision is about where the dependency lives, not about supporting a second framework. It
records what the measurement found, and stops it from silently degrading.

## Alternatives considered

- **`ITable<F, Req = FastifyRequest>`** — rejected for now, as above: the churn is large, it
  changes the public types, and mixed `DbTables` maps get awkward. It is the right shape for a
  three-package split and can be done then, from this seam, in one file's worth of decisions.
- **Leave `FastifyRequest` inline and write the constraint in the docs** — rejected: a property
  that thirteen files must remember is a property that lasts until the next hook is added.
  Gates, not documentation (ADR 0012).
- **Make the core read nothing by typing the request as `unknown`** — rejected: it would break
  every consumer's typed hook to express something the consumer does not need to know.

## Consequences

- Consumers see no change: `ApiRequest` *is* `FastifyRequest`, and it is exported from the
  package for anyone declaring a hook outside a `defineTable` call.
- The core cannot regress. An engine that starts naming a Fastify type fails `npm run verify`.
- A second HTTP adapter is now a question about `src/routes/` (582 lines) plus what Fastify does
  for free — request validation against the generated schemas, and response serialization, which
  is part of the contract rather than plumbing — and not a question about the engine at all.
- Fixing the rule so it could fire revealed that `no-static-optional-peer` had never been able
  to: `includeOnly: '^src/'` dropped every npm edge from the graph. It is live now, qualified to
  what its name says (static, value-level imports of optional peers).
