import { Type, type Static, type TSchema, type TUnsafe } from '@sinclair/typebox';

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
 * returned unchanged.
 */
export function Nullable<T extends TSchema>(schema: T): TUnsafe<Static<T> | null> {
  const type = (schema as { type?: string | string[] }).type;
  if (!type) return schema;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('null')) return schema;
  return Type.Unsafe<Static<T> | null>({ ...schema, type: [...types, 'null'] });
}
