# 0032. `tenantScope` names schema fields, resolved to their columns

- **Status**: accepted
- **Date**: 2026-11-18

## Context

Every key of a table config names schema fields — `primary`, `readExclude`, `upsertKey`,
`defaultOrder`, the fields of `buildRelation` — except `tenantScope`, which named real DB
columns. The reasons given were that the scope is applied to the SQL, after the payload has been
converted, and that `through.foreignField` belongs to a parent table that may have no generated
schema. A startup check refused a field name whose column differs, since that was the likely
mistake.

Neither reason holds. Every name in a scope belongs to a table whose schema the scope already
carries: `column`, `anyOf` and `through.localField` to the table's own, the indirect `column`
and `through.foreignField` to `through.schema`, which is required. And the exception produced
the mistake it guarded against: the CLI's own `tables` template wrote the FK field
(`localField: 'customerId'`), which `defineTable` then refused on a snake_case database.

## Decision

**`tenantScope` names schema fields, each resolved to its column through the schema of the table
it lives on.** A name that schema does not carry is a column as written.

- The resolution happens where the scope is read (`resolvedTenantScope`), so a table config
  built without `defineTable` gets it too; the engines see columns, as before.
- A scope naming real columns keeps working: a column name is not a field, so it is taken as
  written. A hand-written schema that omits the tenant column works the same way.
- An `anyOf` scope that names one column twice — once by its field, once by its column — is
  refused by `defineTable`, like any repeated entry.

## Alternatives considered

- **Keep columns, fix only the CLI template** — rejected: it keeps the one exception to the
  naming rule, the one that produced the template's mistake.
- **Fields only, refusing a name that is not a field** — rejected: a hand-written schema may
  legitimately omit the tenant column, and every 0.6 scope would have to be rewritten for no
  gain in safety.

## Consequences

- The startup check refusing a field name whose column differs is gone: that name is now the
  documented form.
- A misspelled field is not caught at startup: it is taken as a column, and the first query on
  the table fails with a 500 naming it, as a misspelled column did before.
- The docs, the CLI template and the upgrade guide use field names.
