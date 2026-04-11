import type { SchemaDefinition } from '../types.js';

export function toCamelCase(str: string): string {
  return str.replace(/([-_])([a-zA-Z])/g, (_, _sep, char) =>
    char.toUpperCase()
  );
}

export function toUnderscore(str: string): string {
  return str
    .replace(/([A-Z])/g, '|$1')
    .split('|')
    .map((a, index) => (index === 0 ? a : a[0].toLowerCase() + a.substring(1)))
    .join('_');
}

// Reverse colMap cache: colMap object → { column: field }
const reverseCache = new WeakMap<Record<string, string>, Record<string, string>>();

function getReverseMap(colMap: Record<string, string>): Record<string, string> {
  let reverse = reverseCache.get(colMap);
  if (!reverse) {
    reverse = {};
    for (const [field, col] of Object.entries(colMap)) {
      reverse[col] = field;
    }
    reverseCache.set(colMap, reverse);
  }
  return reverse;
}

/**
 * Convert API record (camelCase keys) to DB record (actual column names).
 * Uses schema.colMap when available, falls back to toUnderscore.
 */
export function snakecaseRecord(
  obj: Record<string, unknown>,
  schema?: SchemaDefinition
): Record<string, unknown> {
  const mapFn = schema?.colMap
    ? (k: string) => schema.colMap![k] ?? k
    : (k: string) => toUnderscore(k);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [mapFn(k), v])
  );
}

/**
 * Convert DB row (actual column names) to API record (camelCase field names).
 * Uses schema.colMap when available, falls back to toCamelCase.
 */
export function camelcaseObject<T extends Record<string, unknown>>(
  obj: T,
  schema?: SchemaDefinition
): Record<string, unknown> {
  if (schema?.colMap) {
    const reverse = getReverseMap(schema.colMap);
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [reverse[k] ?? k, v])
    );
  }
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [toCamelCase(k), v])
  );
}

export function toSchemaName(tableName: string): string {
  return (
    'Schema' +
    tableName
      .split('_')
      .map((w) => w.substring(0, 1).toUpperCase() + w.substring(1))
      .join('')
  );
}
