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

export interface DetectedRelation {
  parentSchemaName: string;
  parentField: string;
  childSchemaName: string;
  childField: string;
}

// ─── Parsing ─────────────────────────────────────────────────

export function parseSchemaFile(content: string): ParsedSchema | null {
  const tableNameMatch = content.match(/tableName:\s*"([^"]+)"/);
  if (!tableNameMatch) return null;

  const exportMatch = content.match(/export const (Schema\w+)\s*=\s*Schema/);
  if (!exportMatch) return null;

  const schemaBlockMatch = content.match(/const _Schema\s*=\s*\{([\s\S]*?)};/);
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
  const pkMatch = content.match(/primaryKey:\s*\[([^\]]*)\]/);
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
  return Array.isArray(pk) ? `[${pk.map((p) => `'${p}'`).join(', ')}]` : `'${pk}'`;
}

/** All PK fields as an array, for "non-PK field" lookups in example snippets. */
function pkFields(pk: string | string[]): string[] {
  return Array.isArray(pk) ? pk : [pk];
}

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

export function generateSingleTableFile(schema: ParsedSchema, allSchemas: ParsedSchema[]): string {
  const relations = detectRelations(allSchemas);

  const relsByParent = new Map<string, DetectedRelation[]>();
  const relsByChild = new Map<string, DetectedRelation[]>();
  for (const rel of relations) {
    const arr = relsByParent.get(rel.parentSchemaName) || [];
    arr.push(rel);
    relsByParent.set(rel.parentSchemaName, arr);
    const childArr = relsByChild.get(rel.childSchemaName) || [];
    childArr.push(rel);
    relsByChild.set(rel.childSchemaName, childArr);
  }

  const { pk, autoIncrement } = detectPrimaryKey(schema);
  const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
  const parentRels = relsByParent.get(schema.schemaName) || [];
  const childRels = relsByChild.get(schema.schemaName) || [];

  // Collect related schema names for commented imports
  const relatedSchemas = new Set<string>();
  for (const rel of parentRels) {
    if (rel.childSchemaName !== schema.schemaName) relatedSchemas.add(rel.childSchemaName);
    if (rel.parentSchemaName !== schema.schemaName) relatedSchemas.add(rel.parentSchemaName);
  }
  for (const rel of childRels) {
    if (rel.parentSchemaName !== schema.schemaName) relatedSchemas.add(rel.parentSchemaName);
    if (rel.childSchemaName !== schema.schemaName) relatedSchemas.add(rel.childSchemaName);
  }

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
  lines.push(`  //     if (filters.q) condition.isILike(Schema.col('${schema.fields.includes('name') ? 'name' : schema.fields[0]}'), \`%\${filters.q}%\`);`);
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

  if (parentRels.length > 0) {
    lines.push(`  // allowedReadJoins: [`);
    for (const rel of parentRels) {
      lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
    }
    lines.push(`  // ],`);
  } else {
    lines.push(`  // allowedReadJoins: [],`);
  }

  lines.push(`  // upsertMap: buildUpsertRules(buildUpsertRule(Schema, [${pkFields(pk).map((p) => `'${p}'`).join(', ')}])),`);

  // schemaOverrides: suggest email format if email field exists, otherwise minLength on first string field
  const emailField = schema.fields.find(f => f.toLowerCase().includes('email'));
  if (emailField) {
    lines.push(`  // schemaOverrides: { ${emailField}: Type.String({ format: 'email' }) },`);
  } else {
    const stringField = schema.fields.find(f => !pkFields(pk).includes(f) && schema.fieldTypes[f]?.includes('String'));
    if (stringField) {
      lines.push(`  // schemaOverrides: { ${stringField}: Type.String({ minLength: 1 }) },`);
    } else {
      lines.push(`  // schemaOverrides: {},`);
    }
  }

  // validate: use first non-PK field for example
  const exampleField = schema.fields.find(f => !pkFields(pk).includes(f)) || schema.fields[0];
  lines.push(`  validate: async (db, req, main, secondaries) => {`);
  lines.push(`    const errors: ValidationError[] = [];`);
  lines.push(`    // if (!main.${exampleField}) errors.push(['${exampleField}', 'required']);`);
  lines.push(`    return errors;`);
  lines.push(`  },`);

  lines.push(`  // beforeInsert: async (db, req, record) => {},`);
  lines.push(`  // beforeUpdate: async (db, req, fields) => {},`);

  if (childRels.length > 0) {
    const rel = childRels[0];
    lines.push(`  // tenantScope: { column: 'tenant_col', through: { schema: ${rel.parentSchemaName}, localField: '${rel.childField}', foreignField: '${rel.parentField}' } },`);
  } else {
    lines.push(`  // tenantScope: { column: 'tenant_col' },`);
  }

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

export function generateTablesFile(schemas: ParsedSchema[]): string {
  const relations = detectRelations(schemas);

  const relsByParent = new Map<string, DetectedRelation[]>();
  const relsByChild = new Map<string, DetectedRelation[]>();
  for (const rel of relations) {
    const arr = relsByParent.get(rel.parentSchemaName) || [];
    arr.push(rel);
    relsByParent.set(rel.parentSchemaName, arr);

    const childArr = relsByChild.get(rel.childSchemaName) || [];
    childArr.push(rel);
    relsByChild.set(rel.childSchemaName, childArr);
  }

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
    const { pk, autoIncrement } = detectPrimaryKey(schema);
    const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
    const parentRels = relsByParent.get(schema.schemaName) || [];

    lines.push(``);
    lines.push(`// ─── ${schema.tableName} ──────────────────────────────`);
    lines.push(`// Fields: ${schema.fields.join(', ')}`);
    lines.push(`const ${tableVarName} = defineTable({`);
    lines.push(`  primary: ${formatPrimary(pk)},`);
    lines.push(`  ...exportTableInfo(${schema.schemaName}),`);
    lines.push(`  defaultOrder: '${pkFirst(pk)}',`);

    if (autoIncrement) {
      lines.push(`  excludeFromCreation: ['${pkFirst(pk)}'],`);
    } else {
      lines.push(`  // excludeFromCreation: [],`);
    }

    if (parentRels.length > 0) {
      lines.push(`  // allowedReadJoins: [`);
      for (const rel of parentRels) {
        lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
      }
      lines.push(`  // ],`);
    } else {
      lines.push(`  // allowedReadJoins: [],`);
    }

    lines.push(`  // upsertMap: buildUpsertRules(buildUpsertRule(${schema.schemaName}, [${pkFields(pk).map((p) => `'${p}'`).join(', ')}])),`);
    lines.push(`  // schemaOverrides: {},`);

    const exampleFieldLegacy = schema.fields.find(f => !pkFields(pk).includes(f)) || schema.fields[0];
    lines.push(`  validate: async (db, req, main, secondaries) => {`);
    lines.push(`    const errors: ValidationError[] = [];`);
    lines.push(`    // if (!main.${exampleFieldLegacy}) errors.push(['${exampleFieldLegacy}', 'required']);`);
    lines.push(`    return errors;`);
    lines.push(`  },`);

    lines.push(`  // beforeInsert: async (db, req, record) => {},`);
    lines.push(`  // beforeUpdate: async (db, req, fields) => {},`);

    const childRels = relsByChild.get(schema.schemaName) || [];
    if (childRels.length > 0) {
      const rel = childRels[0];
      lines.push(`  // tenantScope: { column: 'tenant_col', through: { schema: ${rel.parentSchemaName}, localField: '${rel.childField}', foreignField: '${rel.parentField}' } },`);
    } else {
      lines.push(`  // tenantScope: { column: 'tenant_col' },`);
    }

    lines.push(`});`);
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
