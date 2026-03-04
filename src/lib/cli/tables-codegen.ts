import { toUnderscore } from '../naming.js';

// ─── Types ───────────────────────────────────────────────────

export interface ParsedSchema {
  schemaName: string;
  tableName: string;
  fields: string[];
  fieldTypes: Record<string, string>;
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

  return {
    schemaName: exportMatch[1],
    tableName: tableNameMatch[1],
    fields,
    fieldTypes,
  };
}

// ─── Detection ───────────────────────────────────────────────

function detectPrimaryKey(schema: ParsedSchema): { pk: string; autoIncrement: boolean } {
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
          parentField: pk,
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

  // Header comment
  lines.push(`/** defineTable() docs: https://github.com/nicholasgasior/fastify-auto-sqlapi#definetable */`);

  // Imports
  lines.push(`import {`);
  lines.push(`  Type,`);
  lines.push(`  exportTableInfo,`);
  lines.push(`  defineTable,`);
  lines.push(`  buildRelation,`);
  lines.push(`  buildUpsertRules,`);
  lines.push(`  buildUpsertRule,`);
  lines.push(`  ConditionBuilder,`);
  lines.push(`} from 'fastify-auto-sqlapi';`);
  lines.push(``);
  lines.push(`import { ${schema.schemaName} } from '../schemas/${schema.schemaName}.js';`);

  // Commented imports for related schemas
  for (const relSchema of relatedSchemas) {
    lines.push(`// import { ${relSchema} } from '../schemas/${relSchema}.js';`);
  }

  // Table definition
  lines.push(``);
  lines.push(`// Fields: ${schema.fields.join(', ')}`);
  lines.push(`const ${tableVarName} = defineTable({`);
  lines.push(`  primary: '${pk}',`);
  lines.push(`  ...exportTableInfo(${schema.schemaName}),`);
  lines.push(`  defaultOrder: '${pk}',`);

  if (autoIncrement) {
    lines.push(`  excludeFromCreation: ['${pk}'],`);
  } else {
    lines.push(`  // excludeFromCreation: [],`);
  }

  if (parentRels.length > 0) {
    lines.push(`  // allowedReadJoins: [`);
    for (const rel of parentRels) {
      lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
    }
    lines.push(`  // ],`);
    lines.push(`  // allowedWriteJoins: [`);
    for (const rel of parentRels) {
      lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
    }
    lines.push(`  // ],`);
  } else {
    lines.push(`  // allowedReadJoins: [],`);
    lines.push(`  // allowedWriteJoins: [],`);
  }

  lines.push(`  // upsertMap: buildUpsertRules(buildUpsertRule(${schema.schemaName}, ['${pk}'])),`);
  lines.push(`  // beforeInsert: async (db, req, record) => {},`);
  lines.push(`  // afterInsert: async (db, req, record, secondaryRecords) => {},`);
  lines.push(`  // beforeUpdate: async (db, req, fields) => {},`);
  lines.push(`  // onRequests: [],`);

  if (childRels.length > 0) {
    const rel = childRels[0];
    lines.push(`  // tenantScope: { column: 'tenant_col', through: { schema: ${rel.parentSchemaName}, localField: '${rel.childField}', foreignField: '${rel.parentField}' } },`);
  } else {
    lines.push(`  // tenantScope: { column: 'tenant_col' },`);
  }

  lines.push(`});`);
  lines.push(``);
  lines.push(`export default ${tableVarName};`);
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
    lines.push(`import ${tableVarName} from './${tableVarName}.js';`);
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

  // Header comment — defineTable() reference for LLM
  lines.push(`/**`);
  lines.push(` * DbTables — fastify-auto-sqlapi`);
  lines.push(` * Generated by: sqlapi-generate-tables`);
  lines.push(` *`);
  lines.push(` * defineTable() keys:`);
  lines.push(` *   primary               - PK field name (camelCase)`);
  lines.push(` *   ...exportTableInfo()  - Schema + auto-filter builder`);
  lines.push(` *   defaultOrder?         - ORDER BY (e.g. 'name DESC')`);
  lines.push(` *   excludeFromCreation?  - Omit from INSERT (e.g. auto-increment PK)`);
  lines.push(` *   allowedReadJoins?     - Joins for search queries`);
  lines.push(` *   allowedWriteJoins?    - Joins for insert/update secondaries`);
  lines.push(` *   upsertMap?            - ON CONFLICT: buildUpsertRules(buildUpsertRule(Schema, ['field']))`);
  lines.push(` *   beforeInsert?         - async (db, req, record) => void`);
  lines.push(` *   beforeUpdate?         - async (db, req, fields) => void`);
  lines.push(` *   afterInsert?          - async (db, req, record, secondaries) => void`);
  lines.push(` *   distinctResults?      - SELECT DISTINCT`);
  lines.push(` *   onRequests?           - Per-table request hooks (auth, etc.)`);
  lines.push(` *   tenantScope?          - Multi-tenant isolation (see below)`);
  lines.push(` *`);
  lines.push(` * extraFilters + extendedCondition:`);
  lines.push(` *   ...exportTableInfo(Schema, { q: Type.String() }, (condition, opts) => {`);
  lines.push(` *     if (opts.q) condition.isILike('name', \`%\${opts.q}%\`);`);
  lines.push(` *   })`);
  lines.push(` *`);
  lines.push(` * tenantScope (direct — column on this table):`);
  lines.push(` *   tenantScope: { column: 'organization_id' }`);
  lines.push(` *`);
  lines.push(` * tenantScope (indirect — via JOIN to parent table):`);
  lines.push(` *   tenantScope: {`);
  lines.push(` *     column: 'organization_id',`);
  lines.push(` *     through: { schema: SchemaParent, localField: 'parentId', foreignField: 'id' }`);
  lines.push(` *   }`);
  lines.push(` */`);

  // Imports
  lines.push(`import {`);
  lines.push(`  Type,`);
  lines.push(`  exportTableInfo,`);
  lines.push(`  defineTable,`);
  lines.push(`  buildRelation,`);
  lines.push(`  buildUpsertRules,`);
  lines.push(`  buildUpsertRule,`);
  lines.push(`  ConditionBuilder,`);
  lines.push(`} from 'fastify-auto-sqlapi';`);
  lines.push(`import type { DbTables } from 'fastify-auto-sqlapi';`);
  lines.push(``);

  // Schema imports
  for (const schema of schemas) {
    lines.push(`import { ${schema.schemaName} } from './${schema.schemaName}.js';`);
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
    lines.push(`  primary: '${pk}',`);
    lines.push(`  ...exportTableInfo(${schema.schemaName}),`);
    lines.push(`  defaultOrder: '${pk}',`);

    if (autoIncrement) {
      lines.push(`  excludeFromCreation: ['${pk}'],`);
    } else {
      lines.push(`  // excludeFromCreation: [],`);
    }

    if (parentRels.length > 0) {
      lines.push(`  // allowedReadJoins: [`);
      for (const rel of parentRels) {
        lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
      }
      lines.push(`  // ],`);
      lines.push(`  // allowedWriteJoins: [`);
      for (const rel of parentRels) {
        lines.push(`  //   buildRelation(${rel.parentSchemaName}, '${rel.parentField}', ${rel.childSchemaName}, '${rel.childField}'),`);
      }
      lines.push(`  // ],`);
    } else {
      lines.push(`  // allowedReadJoins: [],`);
      lines.push(`  // allowedWriteJoins: [],`);
    }

    lines.push(`  // upsertMap: buildUpsertRules(buildUpsertRule(${schema.schemaName}, ['${pk}'])),`);
    lines.push(`  // beforeInsert: async (db, req, record) => {},`);
    lines.push(`  // afterInsert: async (db, req, record, secondaryRecords) => {},`);
    lines.push(`  // beforeUpdate: async (db, req, fields) => {},`);
    lines.push(`  // onRequests: [],`);

    const childRels = relsByChild.get(schema.schemaName) || [];
    if (childRels.length > 0) {
      // Child table: suggest indirect tenantScope via first parent
      const rel = childRels[0];
      lines.push(`  // tenantScope: { column: 'tenant_col', through: { schema: ${rel.parentSchemaName}, localField: '${rel.childField}', foreignField: '${rel.parentField}' } },`);
    } else {
      // Root table: suggest direct tenantScope
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
