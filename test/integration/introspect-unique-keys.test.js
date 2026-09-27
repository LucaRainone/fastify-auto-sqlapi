// The unique keys the CLI reads from the database (ADR 0021), end to end on a real server:
// introspection + buildTableMap, as the schema generator runs them. Only indexes over plain
// columns are keys an upsert can target — partial, expression and prefix indexes are not.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIALECT, PG_CONNECTION_STRING, MYSQL_CONFIG } from './_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { introspectTables } = await import(path.join(ROOT, 'dist/lib/cli/pg-introspect.js'));
const { introspectMysqlTables } = await import(path.join(ROOT, 'dist/lib/cli/mysql-introspect.js'));
const { buildTableMap } = await import(path.join(ROOT, 'dist/lib/cli/schema-codegen.js'));

async function tableMap() {
  const rows = DIALECT === 'postgres'
    ? await introspectTables(PG_CONNECTION_STRING, 'public')
    : await introspectMysqlTables(MYSQL_CONFIG, MYSQL_CONFIG.database);
  return buildTableMap(rows);
}

describe(`[${DIALECT}] introspection — unique keys`, () => {
  it('reports single-column and composite unique keys, never the primary key', async () => {
    const map = await tableMap();
    assert.deepEqual(map.SchemaUniqueKeySample.uniqueKeys, [['code'], ['tenantId', 'slug']]);
  });

  it('reports a composite primary key as primaryKey only', async () => {
    const map = await tableMap();
    assert.deepEqual(map.SchemaProductTranslation.primary, ['productId', 'lang']);
    assert.deepEqual(map.SchemaProductTranslation.uniqueKeys, []);
  });

  it('reports no unique keys for a view', async () => {
    const map = await tableMap();
    assert.deepEqual(map.SchemaCustomerActive.uniqueKeys, []);
  });
});
