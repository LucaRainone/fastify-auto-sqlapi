// Which MySQL columns the generator is allowed to call "computed by the database".
//
// MySQL puts more than one thing in EXTRA: a real `GENERATED ALWAYS AS (...)` column reports
// 'VIRTUAL GENERATED' or 'STORED GENERATED', but an ordinary column with a default *expression*
// — `DEFAULT CURRENT_TIMESTAMP` above all — reports 'DEFAULT_GENERATED'. Treating the second as
// the first strips every such column out of the write bodies, and a client that sends one gets
// it silently dropped. GENERATION_EXPRESSION is the field that separates them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { mapMysqlColumnRow } = await import(path.join(ROOT, 'dist/lib/cli/mysql-introspect.js'));

/** An information_schema.columns row as mysql2 hands it over, uppercase keys (MySQL 8). */
function row(overrides = {}) {
  return {
    TABLE_NAME: 'orders',
    COLUMN_NAME: 'created_at',
    DATA_TYPE: 'timestamp',
    COLUMN_DEFAULT: 'CURRENT_TIMESTAMP',
    IS_NULLABLE: 'YES',
    COLUMN_KEY: '',
    EXTRA: '',
    GENERATION_EXPRESSION: '',
    TABLE_TYPE: 'BASE TABLE',
    ...overrides,
  };
}

describe('mysql introspection — database-computed columns', () => {
  it('leaves a DEFAULT CURRENT_TIMESTAMP column writable', () => {
    const col = mapMysqlColumnRow(row({ EXTRA: 'DEFAULT_GENERATED' }));
    assert.equal(col.is_generated, false);
  });

  it('leaves a DEFAULT CURRENT_TIMESTAMP ON UPDATE column writable', () => {
    const col = mapMysqlColumnRow(
      row({ EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' })
    );
    assert.equal(col.is_generated, false);
  });

  it('flags a STORED generated column', () => {
    const col = mapMysqlColumnRow(row({
      COLUMN_NAME: 'subtotal',
      EXTRA: 'STORED GENERATED',
      GENERATION_EXPRESSION: '(`qty` * `price`)',
    }));
    assert.equal(col.is_generated, true);
  });

  it('flags a VIRTUAL generated column', () => {
    const col = mapMysqlColumnRow(row({
      COLUMN_NAME: 'status_code',
      EXTRA: 'VIRTUAL GENERATED',
      GENERATION_EXPRESSION: "json_unquote(json_extract(`payload`,'$.status'))",
    }));
    assert.equal(col.is_generated, true);
  });

  it('flags a generated column reported in MariaDB lowercase keys', () => {
    const col = mapMysqlColumnRow({
      table_name: 'orders',
      column_name: 'subtotal',
      data_type: 'int',
      column_default: null,
      is_nullable: 'YES',
      column_key: '',
      extra: 'VIRTUAL GENERATED',
      generation_expression: '`qty` * `price`',
      table_type: 'BASE TABLE',
    });
    assert.equal(col.is_generated, true);
  });

  it('flags a generated column whose EXTRA the driver did not report', () => {
    const col = mapMysqlColumnRow(row({
      COLUMN_NAME: 'subtotal',
      EXTRA: '',
      GENERATION_EXPRESSION: '(`qty` * `price`)',
    }));
    assert.equal(col.is_generated, true);
  });

  it('leaves an AUTO_INCREMENT primary key writable and flagged as auto-increment', () => {
    const col = mapMysqlColumnRow(row({
      COLUMN_NAME: 'id',
      DATA_TYPE: 'int',
      COLUMN_DEFAULT: null,
      COLUMN_KEY: 'PRI',
      EXTRA: 'auto_increment',
    }));
    assert.equal(col.is_auto_increment, true);
    assert.equal(col.is_generated, false);
    assert.equal(col.is_primary, true);
  });
});
