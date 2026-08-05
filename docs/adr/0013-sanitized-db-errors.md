# 0013. Database error messages are sanitized on the wire by default

- **Status**: accepted — narrows [0006](./0006-raw-db-errors.md)
- **Date**: 2026-08-05

## Context

[ADR 0006](./0006-raw-db-errors.md) rejected two distinct proposals in one decision: mapping
SQLSTATE codes to HTTP semantics, and sanitizing driver messages. The first rejection holds
— the mapping is dialect-specific and encodes product decisions the plugin should not make.
The second rested on "hiding details is an environment policy, and Fastify already gives
consumers the hook for it", and three facts undermine it:

- The plugin installs its own `setErrorHandler` in the routes' child scope
  (`src/routes/auto/plugin.ts`), and it sends `error.message` verbatim for any status code.
  A consumer handler registered on the parent scope never sees these errors, so the escape
  route 0006 points at does not exist for the main-plugin path.
- The posture is inconsistent with the rest of the codebase. `maxItemsPerPage`,
  `maxBulkItems`, prototype-key filtering and the join field allowlist are all guards the
  plugin applies by default where the cost is zero. A constraint name describing the schema
  to whoever triggered a duplicate is the same class of free hardening.
- [ADR 0002](./0002-open-by-default.md) amplifies the exposure: the scenario the plugin
  optimizes for — internal scaffolding wired up in five minutes — is exactly the one where
  nobody wrote an error handler.

The failure mode is silent. A consumer who never thinks about it ships the leak and gets no
signal.

## Decision

Errors escaping an auto-generated route handler are replaced with a bare
`500 Internal Server Error` carrying no database detail. Errors the plugin raises itself are
deliberate `4xx` with messages written for clients (`httpError`, `validationErrors`) and pass
through untouched — the rule is `statusCode` in `[400, 500)`, nothing else.

No status code is remapped: a `500` stays a `500`. ADR 0006 stands on that point.

Nothing is lost. The original error is logged through `request.log.error` and attached as the
`cause` of the error the consumer's `setErrorHandler` receives, so unique-violation → `409`
remains implementable, and remains the consumer's decision. The sanitized body carries
`requestId` — the same value Fastify binds as `reqId` on the request logger — so the client
can name the log line holding the real error instead of describing a `500` that happened
"around then".

Developing against the API is a real need the log does not serve — a client building on it,
an agent especially, may have no way to read the server's log, and a round trip per failure
is expensive. `exposeDebugInfo: true` answers it by **adding** a `debugInfo` payload (driver
message, `code`, `constraint`/`detail`, stack) beside the fields above, which keep the shape
they have in production. Client-side error handling therefore does not fork between
environments — the difference is extra data, not different data.

`exposeDebugInfo` derives from nothing. Not `debug`, not `NODE_ENV`, not the log level. The
deciding argument is that **`debug` belongs to the consumer**: whoever registers the plugin
decides how it is wired — a constant in one deployment, an environment variable flipped
during an incident in another — so the library cannot assume its lifecycle, and an option
whose value the library does not control must not decide what leaves the server. Beyond that,
`debug` writes to the log, an access-controlled internal channel; the response body is
external, and under ADR 0002 often unauthenticated. And the posture wanted during a
production incident — log everything, tell clients nothing — stops being expressible the
moment one switch drives both.

The guard sits in the handler built by `registerForAllTables`
(`src/routes/auto/route-helpers.ts`) — the single choke point every auto route passes
through, including route plugins registered standalone without the main plugin. The
`debugInfo` payload is copied from the driver error by allowlist, never spread: an error
object that starts carrying the connection config must not reach a client through it.

## Alternatives considered

- **`fastify.setErrorHandler` in the plugin** — rejected: the plugin is registered through
  `fp()`, so a handler installed at that level would hijack error rendering for the
  consumer's entire application, not just the auto routes.
- **Sanitizing inside the existing child-scope handler in `plugin.ts`** — rejected: route
  plugins registered standalone (`searchRoutes` alone, per AGENTS_BACKEND.md "Register only
  specific routes") never reach that handler, and would keep leaking.
- **Leaving it to the consumer, as 0006 decided** — rejected for the three reasons in
  Context; the deciding one is that the plugin's own child-scope handler makes the
  prescribed consumer remedy unreachable.
- **Deriving the behaviour from `debug`** — rejected, for the reasons in Decision: the
  consumer owns that option and may wire it to an environment variable, it currently governs
  an internal channel only, and coupling makes "verbose log, silent response" unexpressible.
  An override (`debug: true` + an explicit opt-out) would keep the combination reachable but
  leaves the default pointing the dangerous way, which is the failure mode this ADR exists to
  close.
- **Keying it on `NODE_ENV`** — rejected. `NODE_ENV !== 'production'` is fail-open: the
  variable is unset often enough in real deployments (a bare `node dist/server.js`, many
  container images, systemd units) that the leak would come back precisely where nothing was
  configured. `NODE_ENV === 'development'` would at least fail closed, but a security-relevant
  response decided by the shell instead of by the registration call is action at a distance.
- **Replacing `message` with the driver text instead of adding `debugInfo`** — rejected: it
  makes one field mean different things in different environments, so client error handling
  has to be written twice. The additive payload costs nothing and carries more, structured.
- **Echoing only the SQLSTATE code** (`23505`, no names) — rejected: a third middle mode is
  harder to reason about than a boolean, and reading meaning into SQLSTATE is the direction
  0006 closed.
- **Sending the detail only to localhost callers** — rejected: it makes the response depend
  on network topology, which reverse proxies routinely flatten.

## Consequences

- Constraint violations reach clients as `{"statusCode":500,"error":"Internal Server
  Error","message":"Internal Server Error","requestId":"…"}`. Diagnosing one requires the
  server log — which is where the error was already going, under that same id.
- Behavioural breaking change for consumers who parsed driver messages out of `500` bodies.
  They read `debugInfo` instead, and only where the deployment opted in.
- Development needs one more line (`exposeDebugInfo: true`) than it did. That is the price of
  the option meaning exactly one thing: what a client sees is readable from the registration
  call alone, without knowing how `debug` or the environment happen to be wired.
- A deployment that leaves `exposeDebugInfo` on by mistake is back to disclosing schema
  detail. The name is the mitigation: `expose` is the word that makes a reader stop, which
  `debug` is not.
- Errors thrown by consumer `onRequests` hooks are outside the handler and unaffected: that
  is consumer code running before the plugin's SQL surface, and its messages are the
  consumer's to write.
