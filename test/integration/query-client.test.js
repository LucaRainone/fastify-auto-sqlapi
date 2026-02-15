import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));

const connectionString = 'postgres://test:test@127.0.0.1:5433/testdb';

describe('QueryClient: single operations', () => {
  let pool, client, db;

  before(async () => {
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    db = new QueryClient(client);
    await client.query('DELETE FROM customer_order');
    await client.query('DELETE FROM product');
    await client.query('DELETE FROM customer');
  });

  after(async () => {
    client.release();
    await pool.end();
  });

  it('insert returns the row', async () => {
    const row = await db.insert('customer', {
      name: 'Mario Rossi',
      email: 'mario@test.it',
      is_active: true,
    });
    assert.ok(row.id);
    assert.equal(row.name, 'Mario Rossi');
  });

  it('update modifies and returns rows', async () => {
    const ins = await db.insert('customer', { name: 'A', email: 'a@t.it' });
    const rows = await db.update('customer', { name: 'B' }, { id: ins.id });
    assert.equal(rows[0].name, 'B');
  });

  it('insertOrUpdate uses EXCLUDED', async () => {
    const ins = await db.insert('product', {
      name: 'Widget',
      price: 10,
      is_available: true,
    });

    const ups = await db.insertOrUpdate(
      'product',
      { id: ins.id, name: 'Widget Pro', price: 25, is_available: true },
      ['id']
    );
    assert.equal(ups.id, ins.id);
    assert.equal(ups.name, 'Widget Pro');
    assert.equal(parseFloat(ups.price), 25);
  });

  it('delete removes and returns rows', async () => {
    const ins = await db.insert('customer', { name: 'Del', email: 'del@t.it' });
    const del = await db.delete('customer', { id: ins.id });
    assert.equal(del[0].id, ins.id);

    const check = await db.query('SELECT * FROM customer WHERE id = $1', [ins.id]);
    assert.equal(check.rows.length, 0);
  });

  it('select with orderBy and limit', async () => {
    await db.insert('customer', { name: 'X1', email: 'x1@t.it' });
    await db.insert('customer', { name: 'X2', email: 'x2@t.it' });

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
    });
    assert.ok(row.created_at);
  });
});

describe('QueryClient: bulk operations', () => {
  let pool, client, db;

  before(async () => {
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    db = new QueryClient(client);
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
    ]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, 'Bulk1');
    assert.equal(rows[2].is_active, false);
  });

  it('bulkInsert handles chunking', async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      name: `Chunk${i}`,
      price: i * 10,
      is_available: true,
    }));

    const rows = await db.bulkInsert('product', records, 2);
    assert.equal(rows.length, 5);
  });

  it('bulkInsertOrUpdate updates existing rows', async () => {
    // First insert
    const inserted = await db.bulkInsert('product', [
      { name: 'Upsert1', price: 10, is_available: true },
      { name: 'Upsert2', price: 20, is_available: true },
    ]);

    // Upsert with updated prices
    const upserted = await db.bulkInsertOrUpdate(
      'product',
      [
        { id: inserted[0].id, name: 'Upsert1 Updated', price: 99, is_available: true },
        { id: inserted[1].id, name: 'Upsert2 Updated', price: 88, is_available: false },
      ],
      ['id']
    );

    assert.equal(upserted.length, 2);
    assert.equal(upserted[0].name, 'Upsert1 Updated');
    assert.equal(parseFloat(upserted[0].price), 99);
    assert.equal(upserted[1].is_available, false);
  });

  it('bulkInsert returns empty for empty input', async () => {
    const rows = await db.bulkInsert('customer', []);
    assert.deepEqual(rows, []);
  });
});
