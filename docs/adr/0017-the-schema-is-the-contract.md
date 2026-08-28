# 0017. The database schema is the API contract — by default, and only by default

- **Status**: accepted
- **Date**: 2026-08-28

## Context

The first objection this plugin meets is always the same: *it couples the API to the database.*
Change a column and you change the API, and through it every client.

The objection is real and worth answering precisely, because the imprecise answer ("it's fine
for internal tools") concedes more than it has to and defends less than it should.

## Decision

The database schema is the API contract **by default**. That is the mechanism, not a shortcut,
and it rests on three things.

**The coupling is exposed, not created.** A hand-written CRUD layer over the same tables is
coupled to exactly the same schema — it just retypes it. Rename a column there and you edit the
model, the DTO, the mapper, the validator, the Swagger annotation and the client, in six places
instead of one. What that layer genuinely buys is different: an indirection that lets the
contract stay still while the schema moves. That is a real thing to want, and it is paid for
continuously and cashed in rarely. This plugin makes the opposite bet, and states it.

**It is checked, not implied.** The Schema files are generated from `information_schema`, so a
schema change that breaks the API breaks it when you regenerate and compile — for TypeScript
consumers, at build time. A hand-written mapper that nobody remembered to update fails in
production instead. (Untyped clients — a browser fetch — still find out at runtime; the
generated Swagger and `GET {prefix}/agent/manifest.md` are what they check against.)

**It is a default, and every part of it is overridable.** The exposed shape is not forced to be
the stored shape:

| To decouple | Use |
|---|---|
| a column exists but must never be read | `readExclude` |
| a column exists but must never be written | `writeExclude` ([ADR 0015](./0015-non-writable-columns.md)) |
| a column must not exist for the API at all | trim it out of the Schema |
| the API type must be stricter than the column | `schemaOverrides` |
| the API value is derived, not stored | `computedFields` |
| the stored representation is not the API one | `afterRead` (decrypt, unpack, rescale) |
| a table must not have all seven routes | `operations` |
| a relation must be named for the API, not the DB | the relation `alias`, plus its `fields` allowlist |
| a filter has no column behind it | `extraFilters` + `extendedCondition` |
| different callers need different surfaces | register the plugin more than once, under different prefixes |

And when none of that fits, the operation is not a CRUD operation: write the route by hand and
call `app.sqlApi.*` inside it. That is not the fallback path — it is the design. The custom
route keeps filters, joins, tenant scoping, hooks and validation; what it does not keep is the
assumption that the endpoint looks like a table.

**Where the objection is right.** A public or third-party API — consumers you cannot redeploy
alongside your schema, a contract with a version number and a deprecation policy — is a surface
whose stability has to outlive refactors. There an indirection that survives schema movement
earns its cost, and generating that surface from the schema is the wrong default. Do not
auto-expose it: keep those tables off the auto routes with `operations`, or behind their own
hand-written endpoints, and let the plugin serve the surface it is for.

That surface is the internal one: back-office and admin tools where superadmin, admin and
tenant-admin roles need full control over the domain, the schema *is* the domain model, and the
people who change a column are the people who change the screen that shows it. There, the
translation layer has no reader — it exists only to be kept in sync with the thing it
translates.

## Alternatives considered

- **A mapping/DTO layer inside the plugin** — rejected: that is the hand-written layer again,
  re-expressed as configuration instead of code, with the same maintenance cost and less
  freedom. The per-concern levers above cover what most projects actually need to hide or
  reshape, and a custom route covers the rest without inventing a second schema language.
- **Frozen schema snapshots, versioned independently of the database** — rejected: a second
  source of truth to keep in sync, which is precisely what [ADR 0001](./0001-no-orm-raw-sql.md)
  refused when it refused an ORM's models and migrations.
- **Saying nothing and letting readers work it out** — rejected: it is the first question every
  reviewer asks, and an unanswered one reads as an unconsidered one.

## Consequences

- Renaming a column changes the API field. Accepted: it is one regeneration, and typed
  consumers fail to compile rather than failing quietly.
- The plugin is not the right tool for a versioned public API, and says so in the README rather
  than leaving it to be discovered.
- Every "the API should not look like the table" request has a specific answer in the table
  above, or is a custom route. Neither is a gap in the plugin.
