import { Type, IsOptional, type TObject, type TSchema } from 'typebox';
import { primaryAsString } from '../../types.js';
import type { TableConfig, SchemaDefinition, DbTables, JoinDefinition } from '../../types.js';
import { readableFieldNames } from '../read-access.js';
import { writableFields, insertExcludedFields } from '../write-access.js';
import { tenantOwnColumns } from '../tenant.js';
import { resolveJoinTableConf, resolvedTenantScope } from '../table-helpers.js';

/**
 * Build a PK-only schema for response shapes (single or composite PK).
 * Falls back to `fallback` field if tableConf is undefined.
 */
export function pkSchema(tableConf: TableConfig | undefined, schema: SchemaDefinition, fallback: string | string[]): Record<string, TSchema> {
  const pk = tableConf?.primary || fallback;
  const fields = Array.isArray(pk) ? pk : [pk];
  const result: Record<string, TSchema> = {};
  for (const f of fields) {
    result[f] = schema.fields[f] || Type.Any();
  }
  return result;
}

/** `action` of a write response: what the statement did to the main row (`WriteAction`). */
export const WriteActionSchema = Type.Union([Type.Literal('inserted'), Type.Literal('updated')]);

/**
 * Path params of the single-record routes, `GET|DELETE /rest/:table/:id`.
 *
 * `:id` is validated against the primary key field's own type rather than as free text: a
 * path parameter is a string on the wire, and Ajv's coercion turns `"7"` into the number an
 * integer PK expects while `"abc"` becomes a structured 400 on `id` instead of a driver
 * error the route can only report as a 500. The PK is Optional in a generated Schema when the
 * database fills it, so the modifier is stripped here: the path always carries the value.
 *
 * The parameter is named `id` whatever the PK field is called; the response names the real
 * field (see `pkSchema`).
 */
export function pkParams(tableConf: TableConfig): TObject {
  const pkField = primaryAsString(tableConf.primary);
  return Type.Object({ id: asRequired(tableConf.schema.fields[pkField] ?? Type.String()) });
}

/**
 * Make the tenant column(s) of a scoped table Optional in a write body. The engine injects the
 * value for a single-tenant caller and validates the one a multi-tenant or `anyOf` caller sends,
 * so the body must offer the field without demanding it — the same reason a secondary's FK is
 * Optional. The scope is resolved to its columns, and each field matched through `col()`.
 */
export function relaxTenantColumns(
  fields: Record<string, TSchema>,
  tableConf: TableConfig | undefined,
  schema: SchemaDefinition
): void {
  const columns = tenantOwnColumns(resolvedTenantScope(tableConf));
  if (columns.length === 0) return;
  for (const field of Object.keys(fields)) {
    if (columns.includes(schema.col(field))) fields[field] = Type.Optional(fields[field]);
  }
}

/**
 * Build secondary table fields for body schemas:
 * - FK field becomes Optional (auto-filled from main)
 * - insertExclude fields become Optional
 * - tenant column(s) become Optional (injected or validated by the engine)
 */
function buildSecondaryFields(
  joinSchema: SchemaDefinition,
  joinField: string,
  secondaryTableConf: TableConfig | undefined
): Record<string, TSchema> {
  const fields: Record<string, TSchema> = writableFields(
    { ...joinSchema.fields },
    secondaryTableConf,
    joinSchema
  );

  if (joinField in fields) {
    fields[joinField] = Type.Optional(fields[joinField]);
  }

  for (const field of insertExcludedFields(secondaryTableConf)) {
    if (field in fields) {
      fields[field] = Type.Optional(fields[field]);
    }
  }

  relaxTenantColumns(fields, secondaryTableConf, joinSchema);

  return fields;
}

/** The same schema without the Optional modifier, i.e. as a required property. */
export function asRequired(schema: TSchema): TSchema {
  if (!IsOptional(schema)) return schema;
  return Type.Required(Type.Object({ value: schema })).properties.value;
}

/**
 * Apply schemaOverrides to a fields record: each matching field becomes the declared schema,
 * verbatim.
 *
 * Write bodies only. An override is a rule about what this API accepts **from now on**, and
 * the rows already in the table were written before it existed — a column narrowed to
 * `format: 'email'` today holds whatever was accepted last year, and one made mandatory today
 * is `NULL` on every pre-existing row. Describing the response with it would publish a promise
 * about data nobody can retroactively make true. Responses stay on the generated type.
 *
 * Verbatim, because on the request side the schema is the rule: an override without
 * `Type.Optional` makes the field mandatory and one without `Nullable` rejects an explicit
 * `null`, whatever the column allows. That is how a column the DB had to leave nullable is
 * made mandatory going forward. Write the modifiers when you want them.
 *
 * Replace-only: an override naming a field the table does not have is ignored, so the
 * declaration can never introduce a property the engine will not produce.
 */
export function applySchemaOverrides(
  fields: Record<string, TSchema>,
  tableConf: TableConfig | undefined
): Record<string, TSchema> {
  if (!tableConf?.schemaOverrides) return fields;
  const result = { ...fields };
  for (const [field, schema] of Object.entries(tableConf.schemaOverrides)) {
    if (field in result && schema) {
      result[field] = schema;
    }
  }
  return result;
}

type JoinFieldsBuilder = (
  join: JoinDefinition,
  secondaryConf: TableConfig | undefined
) => Record<string, TSchema>;

/**
 * Maps each writeJoin alias to a Type.Array(Type.Object(...)) using the provided fields builder.
 * When `itemsPartial` is true, wraps each item with Type.Partial — used for deletion sub-schemas
 * where every field is a matcher (the engine auto-injects the FK to main).
 */
function buildJoinAliasMap(
  tableConf: TableConfig,
  dbTables: DbTables,
  build: JoinFieldsBuilder,
  options: { itemsPartial?: boolean; strictItems?: boolean; include?: (join: JoinDefinition) => boolean } = {}
): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  if (!tableConf.writeJoins?.length) return out;
  const objOpts = options.strictItems ? { additionalProperties: false } : {};
  for (const j of tableConf.writeJoins) {
    if (options.include && !options.include(j)) continue;
    const sc = resolveJoinTableConf(dbTables, j);
    const item = Type.Object(build(j, sc), objOpts);
    // Partial rebuilds the object and drops the source's options: hand them over again.
    out[j.alias] = Type.Array(options.itemsPartial ? Type.Partial(item, objOpts) : item);
  }
  return out;
}

/** An alias map as an Optional, open object: see `attachRequestSections`. */
function aliasSection(map: Record<string, TSchema>): TSchema {
  return Type.Optional(Type.Partial(Type.Object(map)));
}

/** A relation `replace` can address: one with an `upsertKey` to tell its rows apart (ADR 0029). */
const replaceable = (join: JoinDefinition): boolean => join.upsertKey !== undefined;

/**
 * Attach the child-row sections of a write request to a body schema, in place: `upsert` for
 * every write join, `delete` (update and bulk upsert, `withDelete`) with every field Optional —
 * the engine fills in the FK, the client names the key — and `replace` for the relations with
 * an `upsertKey`, omitted when none has one.
 *
 * Every alias container stays open: an alias the table does not declare, or one `replace`
 * cannot address, must reach the engine, which refuses it with a 400 at that alias
 * (`assertWriteJoinAliases`). Closed, Fastify's default Ajv (`removeAdditional`) would strip
 * it, and the write would answer success with the child rows unwritten.
 */
export function attachRequestSections(
  target: Record<string, TSchema>,
  tableConf: TableConfig,
  dbTables: DbTables,
  options: { withDelete: boolean }
): void {
  if (!tableConf.writeJoins?.length) return;
  const strict = { strictItems: true };
  target.upsert = aliasSection(buildJoinAliasMap(tableConf, dbTables, writeJoinBodyFields, strict));
  if (options.withDelete) {
    target.delete = aliasSection(
      buildJoinAliasMap(tableConf, dbTables, ({ joinSchema }) => joinSchema.fields, { itemsPartial: true })
    );
  }
  if (tableConf.writeJoins.some(replaceable)) {
    target.replace = aliasSection(
      buildJoinAliasMap(tableConf, dbTables, writeJoinBodyFields, { ...strict, include: replaceable })
    );
  }
}

/**
 * Attach the outcome sections of a write response, in place: `secondaries`, the key of every
 * child row written, and `deletions`, the child rows removed. `deletions` lists every write
 * join (`'all'`, update and bulk upsert) or only those a `replace` can address (`'replaced'`,
 * insert — the only removals an insert makes), and is omitted when none qualifies.
 */
export function attachOutcomeSections(
  target: Record<string, TSchema>,
  tableConf: TableConfig,
  dbTables: DbTables,
  options: { deletions: 'all' | 'replaced' }
): void {
  if (!tableConf.writeJoins?.length) return;
  target.secondaries = aliasSection(buildJoinAliasMap(tableConf, dbTables, writeJoinResponseFields));
  const include = options.deletions === 'all' ? undefined : replaceable;
  if (!include || tableConf.writeJoins.some(include)) {
    target.deletions = aliasSection(
      buildJoinAliasMap(tableConf, dbTables, ({ joinSchema }) => joinSchema.fields, { itemsPartial: true, include })
    );
  }
}

/** JoinFieldsBuilder for body schemas: includes all join fields with FK + excluded made Optional. */
const writeJoinBodyFields: JoinFieldsBuilder = (j, sc) =>
  buildSecondaryFields(j.joinSchema, j.joinField, sc);

/**
 * JoinFieldsBuilder for response schemas: the child's primary key — its table config's, else
 * its Schema's, else the join field, as the engine reports it.
 */
const writeJoinResponseFields: JoinFieldsBuilder = (j, sc) =>
  pkSchema(sc, j.joinSchema, j.joinSchema.primaryKey ?? j.joinField);

/** Schema fields minus the ones hidden by `readExclude`. */
export function readableFields(
  schema: SchemaDefinition,
  tableConf: TableConfig | undefined
): Record<string, TSchema> {
  if (!tableConf?.readExclude?.length) return { ...schema.fields };
  const out: Record<string, TSchema> = {};
  for (const field of readableFieldNames(tableConf, schema)) {
    out[field] = schema.fields[field];
  }
  return out;
}
