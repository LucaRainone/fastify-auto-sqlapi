# 0024. The consumer maps driver error codes through `dbErrors` — the plugin ships no mapping

- **Status**: accepted — narrows [0006](./0006-raw-db-errors.md) and
  [0013](./0013-sanitized-db-errors.md)
- **Date**: 2026-11-15

## Context

[ADR 0006](./0006-raw-db-errors.md) kept SQLSTATE→HTTP mapping out of the plugin and left it
to the consumer: "set a Fastify `setErrorHandler` — one place, their policy, their status
codes". [ADR 0013](./0013-sanitized-db-errors.md) kept that remedy, promising the original
error as the `cause` of "the error the consumer's `setErrorHandler` receives, so
unique-violation → `409` remains implementable".

With the main plugin it is not implementable. The plugin renders its envelope from an error
handler installed in the routes' child scope, and Fastify hands an error to the nearest
handler only: one the consumer sets on the application is never called for an auto route.
0013's own Context notes this ("a consumer handler registered on the parent scope never sees
these errors") and then relies on the opposite. The documented `err.cause.code === '23505'`
recipe silently did nothing, and a duplicate email could only ever be a `500`.

What 0006 rejected still holds: a mapping the plugin ships would be dialect-specific, partial
by nature — codes depend on the database and its version — and would encode product
decisions (is a foreign-key violation a `409`, a `422`, a `400`?) that are not the library's.

## Decision

The consumer declares the driver codes it cares about in a plugin option:

```ts
dbErrors: { '23505': { status: 409, code: 'duplicate' }, 'ER_DUP_ENTRY': { status: 409, code: 'duplicate' } }
```

- The key is the driver's `err.code` exactly as it arrives. The plugin interprets nothing and
  ships no entry.
- The value is `{ status, code }`: a status between 400 and 599 and a non-empty code of the
  consumer's choosing. Anything else fails registration.
- A mapped error is answered in the plugin's envelope: the status, its reason phrase as
  `message`, `requestId`, and `fields: [{ path: '', code }]` whatever the status. The client
  translates the code; the API carries no prose. This widens the envelope rule "`fields` on
  every 400" to "and on any answer whose cause carries a code", so machine codes have one
  place.
- No driver detail reaches the client (0013 unchanged). `exposeDebugInfo` stays additive.
- An unmapped error is the sanitized `500`, as before. The driver error is logged either way:
  at `error` when unmapped, at `info` when mapped, since a mapped code is an expected outcome.
- The mapping sits in the same choke point as the sanitizer, so a route plugin registered
  standalone hands the mapped error, `cause` attached, to the consumer's own handler.

## Alternatives considered

- **Rethrow unmapped errors to the parent scope's handler** — rejected: the consumer handler
  would see them, but an application without one would answer with Fastify's default body,
  outside the envelope and without `requestId`. The response shape would depend on code the
  plugin cannot see.
- **A function, `mapError(err, req)`** — rejected: the need is a lookup on a handful of codes,
  and a function makes the policy invisible to anyone reading the registration. A predicate
  the lookup cannot express belongs in a custom route.
- **A consumer-written `message`** — rejected: prose in the API cannot be translated, and a
  client would have to parse it. The client gets a code and owns the wording.
- **A bare status, `{ '23505': 409 }`** — rejected: the client could not tell two mapped
  errors with the same status apart, and a code defaulting to the driver's would make the
  client's translations depend on the database.
- **The code at the top level of the envelope** — rejected: `fields[].code` is already where a
  client reads machine codes. A second location would make every client check two places.
- **Shipping default mappings for common codes** — rejected for the reasons in 0006.

## Consequences

- Unique violation → `409` is one line of configuration, per database: `'23505'` on
  PostgreSQL, `'ER_DUP_ENTRY'` on MySQL and MariaDB. Mapping both to the same code keeps the
  client independent of the database.
- `fields` may now appear on a status other than 400, only on a `dbErrors` answer.
- The driver code alone cannot name the column (`23505` covers every unique constraint), so
  `path` is always `''`. A field-level message needs `validate`, which knows the field.
- `sqlApi.*` is not affected: application code calling it receives the driver error as is and
  decides there.
- The `setErrorHandler` recipe in AGENTS_BACKEND.md is replaced by `dbErrors`. It still
  applies to route plugins registered standalone, which leave rendering to the consumer.
