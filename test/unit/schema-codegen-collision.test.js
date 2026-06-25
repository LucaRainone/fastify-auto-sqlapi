import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { buildTableMap } = await import(path.join(ROOT, 'dist/lib/cli/schema-codegen.js'));

function col(table, column, udt = 'varchar') {
  return {
    table_name: table,
    column_name: column,
    udt_name: udt,
    column_default: null,
    is_nullable: 'NO',
  };
}

describe('buildTableMap - naming collision detection', () => {
  it('throws an explicit error when two columns map to the same camelCase field', () => {
    // user_name and userName both become "userName": a silent overwrite would
    // drop one column from the colMap.
    const rows = [
      col('users', 'id', 'int4'),
      col('users', 'user_name'),
      col('users', 'userName'),
    ];

    assert.throws(
      () => buildTableMap(rows),
      (err) => {
        assert.ok(err.message.includes('user_name'), `error must name the first column, got: ${err.message}`);
        assert.ok(err.message.includes('userName'), `error must name the second column, got: ${err.message}`);
        assert.ok(err.message.includes('users'), `error must name the table, got: ${err.message}`);
        return true;
      }
    );
  });

  it('does not throw for distinct fields', () => {
    const rows = [
      col('users', 'id', 'int4'),
      col('users', 'user_name'),
      col('users', 'email'),
    ];

    const map = buildTableMap(rows);
    assert.deepEqual(Object.keys(map.SchemaUsers.fields), ['id', 'userName', 'email']);
  });

  it('does not throw for same-named columns on different tables', () => {
    const rows = [
      col('users', 'user_name'),
      col('accounts', 'user_name'),
    ];

    const map = buildTableMap(rows);
    assert.equal(map.SchemaUsers.colMap.userName, 'user_name');
    assert.equal(map.SchemaAccounts.colMap.userName, 'user_name');
  });
});
