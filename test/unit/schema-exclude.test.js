import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { applyExcludeTables, applyExcludeColumns } = await import(
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

function makeColumnMap() {
  return {
    SchemaUser: {
      name: 'user',
      fields: {
        id: 'Type.Integer()',
        userName: 'Type.String()',
        passwordHash: 'Type.String()',
        internalScore: 'Type.Optional(Type.Number())',
        fullName: 'Type.Optional(Type.String())',
      },
      colMap: {
        id: 'id',
        userName: 'user_name',
        passwordHash: 'password_hash',
        internalScore: 'internal_score',
        fullName: 'full_name',
      },
      primary: ['id'],
      generated: ['fullName'],
      isView: false,
    },
    SchemaAuditLog: {
      name: 'audit_log',
      fields: { id: 'Type.Integer()', rawPayload: 'Type.Any()', internalNote: 'Type.String()' },
      colMap: { id: 'id', rawPayload: 'raw_payload', internalNote: 'internal_note' },
      primary: ['id'],
      generated: [],
      isView: false,
    },
  };
}

describe('applyExcludeColumns', () => {
  it('removes a matching column from fields and colMap and returns table.column', () => {
    const map = makeColumnMap();
    const excluded = applyExcludeColumns(map, ['user.password_hash']);

    assert.deepEqual(excluded, ['user.password_hash']);
    assert.equal(map.SchemaUser.fields.passwordHash, undefined);
    assert.equal(map.SchemaUser.colMap.passwordHash, undefined);
    assert.deepEqual(Object.keys(map.SchemaUser.fields), ['id', 'userName', 'internalScore', 'fullName']);
    assert.ok(map.SchemaAuditLog.fields.rawPayload);
  });

  it('supports * globs on the table part and on the column part', () => {
    const map = makeColumnMap();
    const excluded = applyExcludeColumns(map, ['*.internal_*', 'audit_*.raw_payload']);

    assert.deepEqual(excluded, ['user.internal_score', 'audit_log.raw_payload', 'audit_log.internal_note']);
    assert.equal(map.SchemaUser.fields.internalScore, undefined);
    assert.equal(map.SchemaAuditLog.fields.rawPayload, undefined);
    assert.equal(map.SchemaAuditLog.fields.internalNote, undefined);
    assert.ok(map.SchemaUser.fields.passwordHash);
  });

  it('matches against the DB table and column names, not the generated names', () => {
    const map = makeColumnMap();
    const excluded = applyExcludeColumns(map, ['SchemaUser.passwordHash', 'user.passwordHash', 'USER.password_hash']);

    assert.deepEqual(excluded, []);
    assert.ok(map.SchemaUser.fields.passwordHash);
  });

  it('does not treat patterns as regular expressions', () => {
    const map = makeColumnMap();
    // "." inside a part must be literal, and "+" is not a quantifier.
    const excluded = applyExcludeColumns(map, ['user.password_has.', 'user.password_has+h']);

    assert.deepEqual(excluded, []);
    assert.ok(map.SchemaUser.fields.passwordHash);
  });

  it('drops an excluded column from generatedFields too', () => {
    const map = makeColumnMap();
    applyExcludeColumns(map, ['user.full_name']);

    assert.deepEqual(map.SchemaUser.generated, []);
    assert.equal(map.SchemaUser.fields.fullName, undefined);
  });

  it('is a no-op with undefined or empty patterns', () => {
    const map = makeColumnMap();
    assert.deepEqual(applyExcludeColumns(map, undefined), []);
    assert.deepEqual(applyExcludeColumns(map, []), []);
    assert.deepEqual(map, makeColumnMap());
  });

  it('throws a clear error when excludeColumns is not an array of strings', () => {
    assert.throws(() => applyExcludeColumns(makeColumnMap(), 'user.password_hash'), /excludeColumns/);
    assert.throws(() => applyExcludeColumns(makeColumnMap(), [42]), /excludeColumns/);
  });

  it('throws when a pattern is not in table.column form', () => {
    assert.throws(() => applyExcludeColumns(makeColumnMap(), ['password_hash']), /table\.column/);
    assert.throws(() => applyExcludeColumns(makeColumnMap(), ['user.']), /table\.column/);
    assert.throws(() => applyExcludeColumns(makeColumnMap(), ['.password_hash']), /table\.column/);
  });

  it('refuses to exclude a primary key column and names the table', () => {
    assert.throws(() => applyExcludeColumns(makeColumnMap(), ['audit_log.id']), /primary key.*audit_log/i);
    // A glob that reaches a primary key is refused too — the runtime has to identify rows.
    assert.throws(() => applyExcludeColumns(makeColumnMap(), ['*.id']), /primary key/i);
  });

  it('refuses to leave a table with no columns and points to excludeTables', () => {
    const map = makeColumnMap();
    map.SchemaUser.primary = [];
    assert.throws(() => applyExcludeColumns(map, ['user.*']), /excludeTables/);
  });
});
