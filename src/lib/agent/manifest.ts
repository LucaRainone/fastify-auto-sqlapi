import type { TSchema } from '@sinclair/typebox';
import { isCompositePrimary } from '../../types.js';
import type { DbTables, ITable, TableOperation } from '../../types.js';

const ALL_OPERATIONS: TableOperation[] = [
  'search', 'get', 'insert', 'update', 'delete', 'bulkUpsert', 'bulkDelete',
];
const SINGLE_PK_OPERATIONS = new Set<TableOperation>(['get', 'delete', 'bulkDelete']);

interface ManifestField {
  type: string;
  /** Present (true) when the field must be sent on insert. */
  required?: boolean;
  /** Present (true) when the column accepts null. */
  nullable?: boolean;
  /** Present (true) when the field is writable but never returned by reads (readExclude). */
  writeOnly?: boolean;
}

interface ManifestJoin {
  alias: string;
  table: string;
  /** '1:N' → usable in joinMustExist/joinMultiple/joinGroup; 'N:1' → usable in joinLeft. */
  kind: '1:N' | 'N:1';
}

export interface ManifestTable {
  /** URL segment for this table's routes. */
  table: string;
  primary: string | string[];
  operations: TableOperation[];
  fields: Record<string, ManifestField>;
  /** Fields stripped from client input on insert (server-generated: PKs, timestamps). */
  serverGenerated?: string[];
  /** Computed (virtual) fields: usable in filters/conditions/orderBy/selectComputed. */
  computed?: Record<string, string>;
  /** Extra filter names accepted in `filters` beyond schema fields. */
  extraFilters?: Record<string, string>;
  readJoins?: ManifestJoin[];
  /** Aliases accepted as `secondaries`/`deletions` keys in writes. */
  writeJoins?: ManifestJoin[];
  /** Present (true) when rows are automatically scoped to the caller's tenant. */
  tenantScoped?: boolean;
  defaultOrder?: string;
}

export interface AgentManifest {
  tables: Record<string, ManifestTable>;
}

function shortType(schema: TSchema | undefined): string {
  if (!schema) return 'any';
  const t = (schema as { type?: string | string[] }).type;
  if (!t) return 'any';
  const types = (Array.isArray(t) ? t : [t]).filter((x) => x !== 'null');
  return types[0] ?? 'any';
}

function isNullable(schema: TSchema | undefined): boolean {
  const t = (schema as { type?: string | string[] } | undefined)?.type;
  return Array.isArray(t) && t.includes('null');
}

function computedTypes(tableConf: ITable): Record<string, string> | undefined {
  if (!tableConf.computedFields) return undefined;
  const out: Record<string, string> = {};
  for (const [name, fn] of Object.entries(tableConf.computedFields)) {
    try {
      const stub = fn({
        db: { qi: (s: string) => s, dialectName: 'postgres' } as never,
        qiCol: () => '""',
      });
      out[name] = shortType(stub.type);
    } catch {
      out[name] = 'any';
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function tableOperations(tableConf: ITable): TableOperation[] {
  const requested = tableConf.operations ?? ALL_OPERATIONS;
  if (!isCompositePrimary(tableConf.primary)) return [...requested];
  return requested.filter((op) => !SINGLE_PK_OPERATIONS.has(op));
}

/**
 * Build the machine-readable description of every table exposed by this deployment:
 * fields (type/required/nullable), enabled operations, join aliases, computed fields,
 * extra filters, tenant scoping. Derived entirely from `DbTables`, so it is always in
 * sync with the running configuration. Pairs with AGENTS_FRONTEND.md (the request grammar)
 * to give an LLM client everything it needs to drive the API.
 */
export function buildAgentManifest(dbTables: DbTables): AgentManifest {
  const tables: Record<string, ManifestTable> = {};

  for (const [key, tableConf] of Object.entries(dbTables)) {
    const schema = tableConf.Schema;
    const required = new Set(
      ((schema.validation as { required?: string[] }).required) ?? []
    );
    const readExcluded = new Set(tableConf.readExclude ?? []);

    const fields: Record<string, ManifestField> = {};
    for (const [name, fieldSchema] of Object.entries(schema.fields)) {
      const f: ManifestField = { type: shortType(fieldSchema as TSchema) };
      if (required.has(name)) f.required = true;
      if (isNullable(fieldSchema as TSchema)) f.nullable = true;
      if (readExcluded.has(name)) f.writeOnly = true;
      fields[name] = f;
    }

    const readJoins: ManifestJoin[] = (tableConf.allowedReadJoins ?? []).map((j) => ({
      alias: j.alias,
      table: j.joinSchema.tableName,
      kind: j.unique ? 'N:1' : '1:N',
    }));
    const writeJoins: ManifestJoin[] = (tableConf.allowedWriteJoins ?? []).map((j) => ({
      alias: j.alias,
      table: j.joinSchema.tableName,
      kind: j.unique ? 'N:1' : '1:N',
    }));

    const extraFilters = Object.keys(tableConf.extraFilters ?? {}).length
      ? Object.fromEntries(
          Object.entries(tableConf.extraFilters).map(([n, s]) => [n, shortType(s)])
        )
      : undefined;

    const entry: ManifestTable = {
      table: schema.tableName,
      primary: tableConf.primary,
      operations: tableOperations(tableConf),
      fields,
    };
    if (tableConf.excludeFromCreation?.length) entry.serverGenerated = [...tableConf.excludeFromCreation];
    const computed = computedTypes(tableConf);
    if (computed) entry.computed = computed;
    if (extraFilters) entry.extraFilters = extraFilters;
    if (readJoins.length) entry.readJoins = readJoins;
    if (writeJoins.length) entry.writeJoins = writeJoins;
    if (tableConf.tenantScope) entry.tenantScoped = true;
    if (tableConf.defaultOrder) entry.defaultOrder = tableConf.defaultOrder;

    tables[key] = entry;
  }

  return { tables };
}

/**
 * Compact markdown rendering of the manifest, designed for an LLM system prompt.
 * Notation: `!` required on insert, `?` nullable, `(writeOnly)` never returned by reads.
 */
export function renderAgentManifestMd(manifest: AgentManifest): string {
  const lines: string[] = [
    '# Tables',
    '',
    'Notation: `!`=required on insert, `?`=nullable, `(writeOnly)`=writable, never in reads.',
    'serverGenerated fields: omit on insert (values from client are ignored).',
    'readJoins aliases: `1:N` → joinMustExist/joinMultiple/joinGroup; `N:1` → joinLeft.',
    'writeJoins aliases: keys for `secondaries`/`deletions` in writes.',
    'filters: unknown keys are rejected (400), never ignored. extraFilters do not apply ' +
      'under joinLeft — use joinMustExist on the same relation.',
    '',
  ];

  for (const t of Object.values(manifest.tables)) {
    const pk = Array.isArray(t.primary) ? t.primary.join('+') : t.primary;
    const flags = t.tenantScoped ? '  [tenant-scoped]' : '';
    lines.push(`## ${t.table}  PK:${pk}  ops:${t.operations.join(',')}${flags}`);

    const fieldParts = Object.entries(t.fields).map(([name, f]) => {
      let s = `${name}:${f.type}`;
      if (f.required) s += '!';
      if (f.nullable) s += '?';
      if (f.writeOnly) s += '(writeOnly)';
      return s;
    });
    lines.push(`fields: ${fieldParts.join(', ')}`);

    if (t.serverGenerated) lines.push(`serverGenerated: ${t.serverGenerated.join(', ')}`);
    if (t.computed) {
      lines.push(`computed: ${Object.entries(t.computed).map(([n, ty]) => `${n}:${ty}`).join(', ')}`);
    }
    if (t.extraFilters) {
      lines.push(`extraFilters: ${Object.entries(t.extraFilters).map(([n, ty]) => `${n}:${ty}`).join(', ')}`);
    }
    if (t.readJoins) {
      lines.push(`readJoins: ${t.readJoins.map((j) => `${j.alias}→${j.table}(${j.kind})`).join(', ')}`);
    }
    if (t.writeJoins) {
      lines.push(`writeJoins: ${t.writeJoins.map((j) => `${j.alias}→${j.table}`).join(', ')}`);
    }
    if (t.defaultOrder) lines.push(`defaultOrder: ${t.defaultOrder}`);
    lines.push('');
  }

  return lines.join('\n');
}
