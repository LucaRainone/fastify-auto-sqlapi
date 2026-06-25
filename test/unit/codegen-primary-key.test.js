import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { buildTableMap, generateSchemaFile, convertColType } = await import(path.join(ROOT, 'dist/lib/cli/schema-codegen.js'));
const { parseSchemaFile, generateSingleTableFile } = await import(path.join(ROOT, 'dist/lib/cli/tables-codegen.js'));

function col(table, column, udt = 'varchar', extra = {}) {
  return {
    table_name: table,
    column_name: column,
    udt_name: udt,
    column_default: null,
    is_nullable: 'NO',
    ...extra,
  };
}

describe('introspected primary key propagation', () => {
  it('buildTableMap collects PK fields (camelCase) from is_primary', () => {
    const rows = [
      col('coupon', 'code', 'varchar', { is_primary: true }),
      col('coupon', 'customer_id', 'int4'),
      col('coupon', 'amount', 'int4'),
    ];

    const map = buildTableMap(rows);
    assert.deepEqual(map.SchemaCoupon.primary, ['code']);
  });

  it('buildTableMap collects composite PKs in column order', () => {
    const rows = [
      col('agent_team', 'agent_id', 'int4', { is_primary: true }),
      col('agent_team', 'team_id', 'int4', { is_primary: true }),
      col('agent_team', 'role', 'varchar'),
    ];

    const map = buildTableMap(rows);
    assert.deepEqual(map.SchemaAgentTeam.primary, ['agentId', 'teamId']);
  });

  it('generateSchemaFile emits primaryKey in the Schema export', () => {
    const content = generateSchemaFile(
      'SchemaCoupon',
      'coupon',
      { code: 'Type.String()', amount: 'Type.Integer()' },
      { code: 'code', amount: 'amount' },
      ['code']
    );

    assert.ok(
      content.includes('primaryKey: ["code"]'),
      `schema file must declare primaryKey, got:\n${content}`
    );
  });

  it('parseSchemaFile reads primaryKey back', () => {
    const content = generateSchemaFile(
      'SchemaCoupon',
      'coupon',
      { code: 'Type.String()', customerId: 'Type.Integer()', amount: 'Type.Integer()' },
      { code: 'code', customerId: 'customer_id', amount: 'amount' },
      ['code']
    );

    const parsed = parseSchemaFile(content);
    assert.ok(parsed, 'schema file must be parseable');
    assert.deepEqual(parsed.primary, ['code']);
  });

  it('generateSingleTableFile uses the declared PK, not the first Integer field', () => {
    // No "id" field, the first Integer field (customerId) is a FK: the old heuristic
    // would wrongly pick customerId as primary.
    const schema = {
      schemaName: 'SchemaCoupon',
      tableName: 'coupon',
      fields: ['customerId', 'code', 'amount'],
      fieldTypes: {
        customerId: 'Type.Integer()',
        code: 'Type.String()',
        amount: 'Type.Integer()',
      },
      primary: ['code'],
    };

    const content = generateSingleTableFile(schema, [schema]);
    assert.ok(
      content.includes(`primary: 'code',`),
      `must use the declared PK 'code', got:\n${content.split('\n').find((l) => l.includes('primary'))}`
    );
  });

  it('generateSingleTableFile emits composite PKs as an array', () => {
    const schema = {
      schemaName: 'SchemaAgentTeam',
      tableName: 'agent_team',
      fields: ['agentId', 'teamId', 'role'],
      fieldTypes: {
        agentId: 'Type.Integer()',
        teamId: 'Type.Integer()',
        role: 'Type.String()',
      },
      primary: ['agentId', 'teamId'],
    };

    const content = generateSingleTableFile(schema, [schema]);
    assert.ok(
      content.includes(`primary: ['agentId', 'teamId'],`),
      `must emit the composite PK, got:\n${content.split('\n').find((l) => l.includes('primary'))}`
    );
  });

  it('generateSingleTableFile falls back to the id heuristic without declared PK (legacy files)', () => {
    const schema = {
      schemaName: 'SchemaUsers',
      tableName: 'users',
      fields: ['id', 'name'],
      fieldTypes: {
        id: 'Type.Optional(Type.Integer())',
        name: 'Type.String()',
      },
    };

    const content = generateSingleTableFile(schema, [schema]);
    assert.ok(content.includes(`primary: 'id',`));
  });

  it('convertColType marks auto_increment columns as Optional (mysql)', () => {
    const out = convertColType('int4', {
      column_default: null,
      is_nullable: 'NO',
      is_auto_increment: true,
    });
    assert.equal(out, 'Type.Optional(Type.Integer())');
  });
});
