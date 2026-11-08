import { Type, IsOptional, type Static, type TSchema, type TUnsafe } from 'typebox';

/**
 * Mark a schema as nullable using the JSON-Schema type-array form
 * (`{ type: ['integer', 'null'] }`).
 *
 * This is the only representation that behaves correctly under Fastify's default Ajv
 * `coerceTypes`: with `Type.Union([T, Type.Null()])` a null body value is coerced by the
 * first branch to 0/""/false — and with the Null branch first, a legitimate 0/""/false is
 * coerced to null. With a type array no coercion happens when the value already matches
 * one of the listed types. fast-json-stringify also serializes NULL correctly against a
 * type array, while a bare `Type.Optional(T)` coerces NULL to the type's zero value.
 *
 * Schemas without a `type` keyword (e.g. `Type.Any()`) already admit null and are
 * returned unchanged. An Optional input stays Optional: TypeBox keeps that modifier in a
 * non-enumerable key, which the spread below does not copy.
 */
export function Nullable<T extends TSchema>(schema: T): TUnsafe<Static<T> | null> {
  const type = (schema as { type?: string | string[] }).type;
  if (!type) return alreadyNullable(schema);
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('null')) return alreadyNullable(schema);
  const nullable = Type.Unsafe<Static<T> | null>({ ...schema, type: [...types, 'null'] });
  return IsOptional(schema) ? Type.Optional(nullable) : nullable;
}

/**
 * A schema that already admits null, returned as-is: its static type already includes
 * `null` (or is `any`), so only the TypeBox wrapper type differs from `TUnsafe`.
 */
function alreadyNullable<T extends TSchema>(schema: T): TUnsafe<Static<T> | null> {
  return schema as unknown as TUnsafe<Static<T> | null>;
}
