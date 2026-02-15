export function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/([-_][a-z])/g, (group) =>
    group.toUpperCase().replace('-', '').replace('_', '')
  );
}

export function toUnderscore(str: string): string {
  return str
    .replace(/([A-Z])/g, '|$1')
    .split('|')
    .map((a, index) => (index === 0 ? a : a[0].toLowerCase() + a.substring(1)))
    .join('_');
}

export function camelcaseObject<T extends Record<string, unknown>>(
  obj: T
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [toCamelCase(k), v])
  );
}

export function snakecaseRecord(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [toUnderscore(k), v])
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
