import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { applyExcludeTables } = await import(
  path.join(ROOT, 'dist/lib/cli/schema-codegen.js')
);

function makeTableMap() {
  const entry = (name) => ({ name, fields: { id: 'Type.Integer()' }, colMap: { id: 'id' }, primary: ['id'] });
  return {
    SchemaCustomer: entry('customer'),
    SchemaKnexMigrations: entry('knex_migrations'),
    SchemaKnexMigrationsLock: entry('knex_migrations_lock'),
    SchemaSpatialRefSys: entry('spatial_ref_sys'),
  };
}

describe('applyExcludeTables', () => {
  it('removes tables matching an exact name and returns them', () => {
    const map = makeTableMap();
    const excluded = applyExcludeTables(map, ['spatial_ref_sys']);

    assert.deepEqual(excluded, ['spatial_ref_sys']);
    assert.equal(map.SchemaSpatialRefSys, undefined);
    assert.ok(map.SchemaCustomer);
    assert.ok(map.SchemaKnexMigrations);
  });

  it('supports * glob patterns on the table name', () => {
    const map = makeTableMap();
    const excluded = applyExcludeTables(map, ['knex_*']);

    assert.deepEqual(excluded, ['knex_migrations', 'knex_migrations_lock']);
    assert.equal(map.SchemaKnexMigrations, undefined);
    assert.equal(map.SchemaKnexMigrationsLock, undefined);
    assert.ok(map.SchemaCustomer);
    assert.ok(map.SchemaSpatialRefSys);
  });

  it('matches against the DB table name, not the schema name', () => {
    const map = makeTableMap();
    // SchemaCustomer would match "Schema*" only if we (wrongly) matched schema names
    const excluded = applyExcludeTables(map, ['Schema*', 'CUSTOMER']);

    assert.deepEqual(excluded, []);
    assert.ok(map.SchemaCustomer);
  });

  it('does not treat patterns as regular expressions', () => {
    const map = makeTableMap();
    // "." must be literal: "custome." would be a regex match for "customer"
    const excluded = applyExcludeTables(map, ['custome.', 'knex_migration+s']);

    assert.deepEqual(excluded, []);
    assert.ok(map.SchemaCustomer);
    assert.ok(map.SchemaKnexMigrations);
  });

  it('is a no-op with undefined or empty patterns', () => {
    const map = makeTableMap();
    assert.deepEqual(applyExcludeTables(map, undefined), []);
    assert.deepEqual(applyExcludeTables(map, []), []);
    assert.equal(Object.keys(map).length, 4);
  });

  it('throws a clear error when excludeTables is not an array of strings', () => {
    assert.throws(() => applyExcludeTables(makeTableMap(), 'knex_*'), /excludeTables/);
    assert.throws(() => applyExcludeTables(makeTableMap(), [42]), /excludeTables/);
  });
});
