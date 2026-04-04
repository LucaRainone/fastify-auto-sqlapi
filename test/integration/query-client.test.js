import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { pgQueryable } = await import(path.join(ROOT, 'dist/lib/adapters/pg-adapter.js'));

const connectionString = 'postgres://test:test@127.0.0.1:5433/testdb';

describe('QueryClient: single operations', () => {
  let pool, client, db;

  before(async () => {
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    db = new QueryClient(pgQueryable(client));
    await client.query('DELETE FROM customer_order');
    await client.query('DELETE FROM product');
    await client.query('DELETE FROM customer');
  });

  after(async () => {
    client.release();
    await pool.end();
  });

  it('insert returns PK-only row', async () => {
    const row = await db.insert('customer', {
      name: 'Mario Rossi',
      email: 'mario@test.it',
      is_active: true,
    }, 'id');
    assert.ok(row.id);
    // PK-only: no other fields in RETURNING
    assert.equal(row.name, undefined);
  });

  it('update returns affected rows count', async () => {
    const ins = await db.insert('customer', { name: 'A', email: 'a@t.it' }, 'id');
    const affectedRows = await db.update('customer', { name: 'B' }, { id: ins.id });
    assert.equal(affectedRows, 1);

    // Verify the update
    const check = await db.query('SELECT name FROM customer WHERE id = $1', [ins.id]);
    assert.equal(check.rows[0].name, 'B');
  });

  it('insertOrUpdate uses EXCLUDED', async () => {
    const ins = await db.insert('product', {
      name: 'Widget',
      price: 10,
      is_available: true,
    }, 'id');

    const ups = await db.insertOrUpdate(
      'product',
      { id: ins.id, name: 'Widget Pro', price: 25, is_available: true },
      ['id'],
      'id'
    );
    assert.equal(ups.id, ins.id);

    // Verify the update
    const check = await db.query('SELECT name, price FROM product WHERE id = $1', [ins.id]);
    assert.equal(check.rows[0].name, 'Widget Pro');
    assert.equal(parseFloat(check.rows[0].price), 25);
  });

  it('delete returns affected rows count', async () => {
    const ins = await db.insert('customer', { name: 'Del', email: 'del@t.it' }, 'id');
    const affectedRows = await db.delete('customer', { id: ins.id });
    assert.equal(affectedRows, 1);

    const check = await db.query('SELECT * FROM customer WHERE id = $1', [ins.id]);
    assert.equal(check.rows.length, 0);
  });

  it('select with orderBy and limit', async () => {
    await db.insert('customer', { name: 'X1', email: 'x1@t.it' }, 'id');
    await db.insert('customer', { name: 'X2', email: 'x2@t.it' }, 'id');

    const rows = await db.select({
      tableName: 'customer',
      where: '1=1',
      values: [],
      orderBy: 'id DESC',
      limit: '2',
    });
    assert.ok(rows.length <= 2);
    if (rows.length === 2) assert.ok(rows[0].id > rows[1].id);
  });

  it('expression injects raw SQL', async () => {
    const row = await db.insert('product', {
      name: 'Expr Test',
      price: 5,
      is_available: true,
      created_at: db.expression('NOW()'),
    }, 'id');
    assert.ok(row.id);

    // Verify expression was applied
    const check = await db.query('SELECT created_at FROM product WHERE id = $1', [row.id]);
    assert.ok(check.rows[0].created_at);
  });
});

describe('QueryClient: bulk operations', () => {
  let pool, client, db;

  before(async () => {
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    db = new QueryClient(pgQueryable(client));
    await client.query('DELETE FROM customer_order');
    await client.query('DELETE FROM product');
    await client.query('DELETE FROM customer');
  });

  after(async () => {
    client.release();
    await pool.end();
  });

  it('bulkInsert inserts multiple rows', async () => {
    const rows = await db.bulkInsert('customer', [
      { name: 'Bulk1', email: 'b1@t.it', is_active: true },
      { name: 'Bulk2', email: 'b2@t.it', is_active: true },
      { name: 'Bulk3', email: 'b3@t.it', is_active: false },
    ], 'id');
    assert.equal(rows.length, 3);
    assert.ok(rows[0].id);
    assert.ok(rows[1].id);
    assert.ok(rows[2].id);
  });

  it('bulkInsert handles chunking', async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      name: `Chunk${i}`,
      price: i * 10,
      is_available: true,
    }));

    const rows = await db.bulkInsert('product', records, 'id', 2);
    assert.equal(rows.length, 5);
  });

  it('bulkInsertOrUpdate updates existing rows', async () => {
    // First insert
    const inserted = await db.bulkInsert('product', [
      { name: 'Upsert1', price: 10, is_available: true },
      { name: 'Upsert2', price: 20, is_available: true },
    ], 'id');

    // Upsert with updated prices
    const upserted = await db.bulkInsertOrUpdate(
      'product',
      [
        { id: inserted[0].id, name: 'Upsert1 Updated', price: 99, is_available: true },
        { id: inserted[1].id, name: 'Upsert2 Updated', price: 88, is_available: false },
      ],
      ['id'],
      'id'
    );

    assert.equal(upserted.length, 2);
    assert.equal(upserted[0].id, inserted[0].id);
    assert.equal(upserted[1].id, inserted[1].id);

    // Verify updates
    const check = await db.query('SELECT name, price, is_available FROM product WHERE id = $1', [inserted[0].id]);
    assert.equal(check.rows[0].name, 'Upsert1 Updated');
    assert.equal(parseFloat(check.rows[0].price), 99);
  });

  it('bulkInsert returns empty for empty input', async () => {
    const rows = await db.bulkInsert('customer', [], 'id');
    assert.deepEqual(rows, []);
  });
});
