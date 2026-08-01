import { toUnderscore } from '../naming.js';

// ─── Types ───────────────────────────────────────────────────

export interface ParsedSchema {
  schemaName: string;
  tableName: string;
  fields: string[];
  fieldTypes: Record<string, string>;
  /** PRIMARY KEY fields declared in the schema file (`primaryKey: [...]`), when present. */
  primary?: string[];
}

interface DetectedRelation {
  parentSchemaName: string;
  parentField: string;
  childSchemaName: string;
  childField: string;
}

// ─── Parsing ─────────────────────────────────────────────────

export function parseSchemaFile(content: string): ParsedSchema | null {
  const tableNameMatch = /tableName:\s*"([^"]+)"/.exec(content);
  if (!tableNameMatch) return null;

  const exportMatch = /export const (Schema\w+)\s*=\s*Schema/.exec(content);
  if (!exportMatch) return null;

  const schemaBlockMatch = /const _Schema\s*=\s*\{([\s\S]*?)};/.exec(content);
  if (!schemaBlockMatch) return null;

  const fields: string[] = [];
  const fieldTypes: Record<string, string> = {};
  const fieldRegex = /^\s+(\w+):\s+(Type\..+)$/gm;
  let match;
  while ((match = fieldRegex.exec(schemaBlockMatch[1])) !== null) {
    fields.push(match[1]);
    fieldTypes[match[1]] = match[2].replace(/,\s*$/, '');
  }

  if (fields.length === 0) return null;

  // primaryKey: ["code"] — emitted by generate-schema from DB introspection
  let primary: string[] | undefined;
  const pkMatch = /primaryKey:\s*\[([^\]]*)\]/.exec(content);
  if (pkMatch) {
    primary = pkMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (primary.length === 0) primary = undefined;
  }

  return {
    schemaName: exportMatch[1],
    tableName: tableNameMatch[1],
    fields,
    fieldTypes,
    primary,
  };
}

// ─── Detection ───────────────────────────────────────────────

function detectPrimaryKey(schema: ParsedSchema): { pk: string | string[]; autoIncrement: boolean } {
  // Preferred source: the PK introspected from the DB (primaryKey in the schema file).
  if (schema.primary?.length) {
    const pk = schema.primary.length === 1 ? schema.primary[0] : schema.primary;
    const first = schema.primary[0];
    return { pk, autoIncrement: schema.fieldTypes[first]?.includes('Optional') ?? false };
  }

  // Heuristic fallback for hand-written/legacy schema files without primaryKey.
  if (schema.fields.includes('id')) {
    return { pk: 'id', autoIncrement: schema.fieldTypes['id']?.includes('Optional') ?? false };
  }
  for (const field of schema.fields) {
    if (schema.fieldTypes[field]?.includes('Integer')) {
      return { pk: field, autoIncrement: schema.fieldTypes[field].includes('Optional') };
    }
  }
  return { pk: schema.fields[0], autoIncrement: false };
}

/** First PK field: used for defaultOrder, relations and example snippets. */
function pkFirst(pk: string | string[]): string {
  return Array.isArray(pk) ? pk[0] : pk;
}

/** Render the `primary:` value for the defineTable template. */
function formatPrimary(pk: string | string[]): string {
  if (!Array.isArray(pk)) return `'${pk}'`;
  const quoted = pk.map((p) => `'${p}'`);
  return `[${quoted.join(', ')}]`;
}

/** All PK fields as an array, for "non-PK field" lookups in example snippets. */
function pkFields(pk: string | string[]): string[] {
  return Array.isArray(pk) ? pk : [pk];
}

/** Infers FK relations between parsed schemas.
 * @testonly Exported only so unit tests can exercise it directly.
 */
export function detectRelations(schemas: ParsedSchema[]): DetectedRelation[] {
  const tableBySnakeName = new Map<string, ParsedSchema>();
  for (const schema of schemas) {
    tableBySnakeName.set(schema.tableName, schema);
  }

  const relations: DetectedRelation[] = [];
  for (const schema of schemas) {
    for (const field of schema.fields) {
      if (!field.endsWith('Id') || field === 'id') continue;
      const parentTableName = toUnderscore(field.slice(0, -2));
      const parent = tableBySnakeName.get(parentTableName);
      if (parent) {
        const { pk } = detectPrimaryKey(parent);
        relations.push({
          parentSchemaName: parent.schemaName,
          parentField: pkFirst(pk),
          childSchemaName: schema.schemaName,
          childField: field,
        });
      }
    }
  }
  return relations;
}

// ─── Single Table File Generation ────────────────────────────

/** Relations grouped by the schema they hang off, in both directions. */
function indexRelations(relations: DetectedRelation[]): {
  byParent: Map<string, DetectedRelation[]>;
  byChild: Map<string, DetectedRelation[]>;
} {
  const byParent = new Map<string, DetectedRelation[]>();
  const byChild = new Map<string, DetectedRelation[]>();

  for (const rel of relations) {
    const parentArr = byParent.get(rel.parentSchemaName) ?? [];
    parentArr.push(rel);
    byParent.set(rel.parentSchemaName, parentArr);

    const childArr = byChild.get(rel.childSchemaName) ?? [];
    childArr.push(rel);
    byChild.set(rel.childSchemaName, childArr);
  }

  return { byParent, byChild };
}

/** Schemas on the other end of a relation — emitted as commented-out imports. */
function collectRelatedSchemas(
  ownName: string,
  ...relationGroups: DetectedRelation[][]
): Set<string> {
  const related = new Set<string>();
  for (const rels of relationGroups) {
    for (const rel of rels) {
      if (rel.childSchemaName !== ownName) related.add(rel.childSchemaName);
      if (rel.parentSchemaName !== ownName) related.add(rel.parentSchemaName);
    }
  }
  return related;
}

/** A plausible `schemaOverrides` example: an email format if there is one, else a minLength. */
function schemaOverridesLine(schema: ParsedSchema, pk: string | string[]): string {
  const emailField = schema.fields.find((f) => f.toLowerCase().includes('email'));
  if (emailField) {
    return `  // schemaOverrides: { ${emailField}: Type.String({ format: 'email' }) },`;
  }

  const stringField = schema.fields.find(
    (f) => !pkFields(pk).includes(f) && schema.fieldTypes[f]?.includes('String')
  );
  return stringField
    ? `  // schemaOverrides: { ${stringField}: Type.String({ minLength: 1 }) },`
    : `  // schemaOverrides: {},`;
}

/** Indirect scope when the table hangs off a parent, direct scope otherwise. */
function tenantScopeLine(childRels: DetectedRelation[]): string {
  const rel = childRels[0];
  if (!rel) return `  // tenantScope: { column: 'tenant_col' },`;
  return `  // tenantScope: { column: 'tenant_col', through: { schema: ${rel.parentSchemaName}, localField: '${rel.childField}', foreignField: '${rel.parentField}' } },`;
}

function allowedReadJoinsLines(parentRels: DetectedRelation[]): string[] {
  if (parentRels.length === 0) return [`  // allowedReadJoins: [],`];

  const lines = [`  // allowedReadJoins: [`];
  for (const rel of parentRels) {
    lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
  }
  lines.push(`  // ],`);
  return lines;
}

export function generateSingleTableFile(schema: ParsedSchema, allSchemas: ParsedSchema[]): string {
  const { byParent, byChild } = indexRelations(detectRelations(allSchemas));

  const { pk, autoIncrement } = detectPrimaryKey(schema);
  const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
  const parentRels = byParent.get(schema.schemaName) ?? [];
  const childRels = byChild.get(schema.schemaName) ?? [];
  const relatedSchemas = collectRelatedSchemas(schema.schemaName, parentRels, childRels);

  const lines: string[] = [];

  // Imports
  lines.push(`import {defineTable, exportTableInfo, Type} from 'fastify-auto-sqlapi';`);
  lines.push(`import type {ValidationError} from 'fastify-auto-sqlapi';`);
  lines.push(`import {${schema.schemaName} as Schema} from '../schemas/${schema.schemaName}.js';`);

  // Commented imports for related schemas
  for (const relSchema of relatedSchemas) {
    lines.push(`// import {${relSchema}} from '../schemas/${relSchema}.js';`);
  }

  lines.push(``);

  // Extra filters placeholder
  lines.push(`// const extraFiltersValidation = Type.Object({`);
  lines.push(`//   q: Type.String(),`);
  lines.push(`// });`);

  // Table definition
  lines.push(``);
  lines.push(`// Fields: ${schema.fields.join(', ')}`);
  lines.push(`export const ${tableVarName} = defineTable({`);
  lines.push(`  primary: ${formatPrimary(pk)},`);
  lines.push(`  ...exportTableInfo(Schema),`);

  // Commented example with extraFilters + extendedCondition
  lines.push(`  // ...exportTableInfo(`);
  lines.push(`  //   Schema,`);
  lines.push(`  //   extraFiltersValidation,`);
  lines.push(`  //   (condition, filters) => {`);
  lines.push(`  //     // Prefix columns with the table name: the query may carry joins, and a`);
  lines.push(`  //     // bare column shared with a joined table would be ambiguous.`);
  lines.push(`  //     if (filters.q) condition.isILike(\`\${Schema.tableName}.\${Schema.col('${schema.fields.includes('name') ? 'name' : schema.fields[0]}')}\`, \`%\${filters.q}%\`);`);
  lines.push(`  //   }`);
  lines.push(`  // ),`);

  lines.push(`  defaultOrder: '${pkFirst(pk)}',`);

  if (autoIncrement) {
    lines.push(`  excludeFromCreation: ['${pkFirst(pk)}'],`);
  } else {
    lines.push(`  // excludeFromCreation: [],`);
  }

  // Hide columns from every read (writes still accept them, e.g. a password hash)
  lines.push(`  // readExclude: [],`);

  lines.push(...allowedReadJoinsLines(parentRels));

  const upsertPk = pkFields(pk).map((p) => `'${p}'`).join(', ');
  lines.push(`  // upsertMap: buildUpsertRules(buildUpsertRule(Schema, [${upsertPk}])),`);
  lines.push(schemaOverridesLine(schema, pk));

  // validate: use first non-PK field for example
  const exampleField = schema.fields.find(f => !pkFields(pk).includes(f)) || schema.fields[0];
  lines.push(`  validate: async (db, req, main, secondaries) => {`);
  lines.push(`    const errors: ValidationError[] = [];`);
  lines.push(`    // if (!main.${exampleField}) errors.push(['${exampleField}', 'required']);`);
  lines.push(`    return errors;`);
  lines.push(`  },`);

  lines.push(`  // beforeInsert: async (db, req, record) => {},`);
  lines.push(`  // beforeUpdate: async (db, req, fields) => {},`);

  lines.push(tenantScopeLine(childRels));

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

// ─── DbTables Index Generation ──────────────────────────────

export function generateDbTablesIndex(schemas: ParsedSchema[]): string {
  const lines: string[] = [];

  lines.push(`import type { DbTables } from 'fastify-auto-sqlapi';`);
  lines.push(``);

  for (const schema of schemas) {
    const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
    lines.push(`import {${tableVarName}} from './${tableVarName}.js';`);
  }

  lines.push(``);
  lines.push(`export const dbTables: DbTables = {`);
  for (const schema of schemas) {
    const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
    lines.push(`  ${schema.tableName}: ${tableVarName},`);
  }
  lines.push(`};`);
  lines.push(``);

  return lines.join('\n');
}

// ─── Code Generation (legacy) ───────────────────────────────

/** One `defineTable({...})` block for the legacy single-file generator. */
function legacyTableBlock(
  schema: ParsedSchema,
  parentRels: DetectedRelation[],
  childRels: DetectedRelation[]
): string[] {
  const { pk, autoIncrement } = detectPrimaryKey(schema);
  const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
  const upsertPk = pkFields(pk).map((p) => `'${p}'`).join(', ');
  const exampleField = schema.fields.find((f) => !pkFields(pk).includes(f)) || schema.fields[0];

  const lines = [
    ``,
    `// ─── ${schema.tableName} ──────────────────────────────`,
    `// Fields: ${schema.fields.join(', ')}`,
    `const ${tableVarName} = defineTable({`,
    `  primary: ${formatPrimary(pk)},`,
    `  ...exportTableInfo(${schema.schemaName}),`,
    `  defaultOrder: '${pkFirst(pk)}',`,
    autoIncrement
      ? `  excludeFromCreation: ['${pkFirst(pk)}'],`
      : `  // excludeFromCreation: [],`,
  ];

  lines.push(...allowedReadJoinsLines(parentRels));
  lines.push(
    `  // upsertMap: buildUpsertRules(buildUpsertRule(${schema.schemaName}, [${upsertPk}])),`,
    `  // schemaOverrides: {},`,
    `  validate: async (db, req, main, secondaries) => {`,
    `    const errors: ValidationError[] = [];`,
    `    // if (!main.${exampleField}) errors.push(['${exampleField}', 'required']);`,
    `    return errors;`,
    `  },`,
    `  // beforeInsert: async (db, req, record) => {},`,
    `  // beforeUpdate: async (db, req, fields) => {},`,
    tenantScopeLine(childRels),
    `});`,
  );

  return lines;
}

/** Legacy single-file DbTables generator.
 * @testonly Exported only so unit tests can exercise it directly.
 */
export function generateTablesFile(schemas: ParsedSchema[]): string {
  const { byParent, byChild } = indexRelations(detectRelations(schemas));

  const lines: string[] = [];

  // Imports
  lines.push(`import {defineTable, exportTableInfo, Type} from 'fastify-auto-sqlapi';`);
  lines.push(`import type { DbTables, ValidationError } from 'fastify-auto-sqlapi';`);
  lines.push(``);

  // Schema imports
  for (const schema of schemas) {
    lines.push(`import {${schema.schemaName}} from './${schema.schemaName}.js';`);
  }

  // Table definitions
  for (const schema of schemas) {
    lines.push(...legacyTableBlock(
      schema,
      byParent.get(schema.schemaName) ?? [],
      byChild.get(schema.schemaName) ?? []
    ));
  }

  // DbTables export
  lines.push(``);
  lines.push(`// ─── DbTables ──────────────────────────────────────`);
  lines.push(`export const dbTables: DbTables = {`);
  for (const schema of schemas) {
    const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
    lines.push(`  ${schema.tableName}: ${tableVarName},`);
  }
  lines.push(`};`);
  lines.push(``);

  return lines.join('\n');
}
