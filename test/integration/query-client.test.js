import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createQueryClient,
  pgQueryable,
  mysqlQueryable,
  PG_CONNECTION_STRING,
  MYSQL_CONFIG,
} from './_helpers.js';

describe(`[${DIALECT}] QueryClient: single operations`, () => {
  let pool;
  let client;
  let db;

  before(async () => {
    if (DIALECT === 'postgres') {
      const pg = (await import('pg')).default;
      pool = new pg.Pool({ connectionString: PG_CONNECTION_STRING });
      client = await pool.connect();
      db = createQueryClient(pgQueryable(client), DIALECT);
    } else {
      const mysql = (await import('mysql2/promise')).default;
      pool = mysql.createPool(MYSQL_CONFIG);
      client = pool;
      db = createQueryClient(mysqlQueryable(pool), DIALECT);
    }
    // Clean — respect FK order
    await db.query(`DELETE FROM ${db.qi('customer_order')}`);
    await db.query(`DELETE FROM ${db.qi('product')}`);
    await db.query(`DELETE FROM ${db.qi('customer')}`);
  });

  after(async () => {
    if (DIALECT === 'postgres') {
      client.release();
    }
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

    const check = await db.query(`SELECT ${db.qi('name')} FROM ${db.qi('customer')} WHERE ${db.qi('id')} = ${db.ph(1)}`, [ins.id]);
    assert.equal(check.rows[0].name, 'B');
  });

  it('insertOrUpdate uses upsert path', async () => {
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

    const check = await db.query(
      `SELECT ${db.qi('name')}, ${db.qi('price')} FROM ${db.qi('product')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [ins.id]
    );
    assert.equal(check.rows[0].name, 'Widget Pro');
    assert.equal(parseFloat(check.rows[0].price), 25);
  });

  it('delete returns affected rows count', async () => {
    const ins = await db.insert('customer', { name: 'Del', email: 'del@t.it' }, 'id');
    const affectedRows = await db.delete('customer', { id: ins.id });
    assert.equal(affectedRows, 1);

    const check = await db.query(
      `SELECT * FROM ${db.qi('customer')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [ins.id]
    );
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
    const nowFn = DIALECT === 'postgres' ? 'NOW()' : 'NOW()';
    const row = await db.insert('product', {
      name: 'Expr Test',
      price: 5,
      is_available: true,
      created_at: db.expression(nowFn),
    }, 'id');
    assert.ok(row.id);

    const check = await db.query(
      `SELECT ${db.qi('created_at')} FROM ${db.qi('product')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [row.id]
    );
    assert.ok(check.rows[0].created_at);
  });
});

describe(`[${DIALECT}] QueryClient: bulk operations`, () => {
  let pool;
  let client;
  let db;

  before(async () => {
    if (DIALECT === 'postgres') {
      const pg = (await import('pg')).default;
      pool = new pg.Pool({ connectionString: PG_CONNECTION_STRING });
      client = await pool.connect();
      db = createQueryClient(pgQueryable(client), DIALECT);
    } else {
      const mysql = (await import('mysql2/promise')).default;
      pool = mysql.createPool(MYSQL_CONFIG);
      client = pool;
      db = createQueryClient(mysqlQueryable(pool), DIALECT);
    }
    await db.query(`DELETE FROM ${db.qi('customer_order')}`);
    await db.query(`DELETE FROM ${db.qi('product')}`);
    await db.query(`DELETE FROM ${db.qi('customer')}`);
  });

  after(async () => {
    if (DIALECT === 'postgres') {
      client.release();
    }
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
    const inserted = await db.bulkInsert('product', [
      { name: 'Upsert1', price: 10, is_available: true },
      { name: 'Upsert2', price: 20, is_available: true },
    ], 'id');

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

    const check = await db.query(
      `SELECT ${db.qi('name')}, ${db.qi('price')} FROM ${db.qi('product')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [inserted[0].id]
    );
    assert.equal(check.rows[0].name, 'Upsert1 Updated');
    assert.equal(parseFloat(check.rows[0].price), 99);
  });

  it('bulkInsert returns empty for empty input', async () => {
    const rows = await db.bulkInsert('customer', [], 'id');
    assert.deepEqual(rows, []);
  });
});
