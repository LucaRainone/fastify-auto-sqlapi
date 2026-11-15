// The upsert key has one place per role: `upsertKey` on the table for its main rows (insert and
// bulk upsert), `upsertKey` on the write relation for the secondaries it writes. The pre-1.0
// `upsertMap` — a Map keyed by Schema object identity, which lost the rule in silence when the
// relation carried another instance — is refused at startup, naming the new keys.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockSchema, createMockPg } from './_harness.js';

const lib = await import(path.join(ROOT, 'dist/index.js'));
const { defineTable, buildRelation, Type } = lib;
const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));

/** A Schema as the CLI generates it: primaryKey and uniqueKeys introspected from the DB. */
const generated = (tableName, fields, meta) => ({ ...createMockSchema(tableName, fields), ...meta });

const customerSchema = generated(
  'customer',
  { id: Type.Integer(), name: Type.String(), email: Type.String() },
  { primaryKey: ['id'], uniqueKeys: [['email']] },
);
const orderSchema = generated(
  'customer_order',
  { id: Type.Integer(), customerId: Type.Integer(), status: Type.String(), total: Type.Number() },
  { primaryKey: ['id'], uniqueKeys: [['customerId', 'status']] },
);

function customerTable(extra = {}) {
  return defineTable({ primary: 'id', schema: customerSchema, defaultOrder: 'id', ...extra });
}

const ordersRelation = (options = {}) =>
  buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders', ...options });

async function insert(tableConf, secondaries) {
  const mockPg = createMockPg([
    { rows: [{ id: 1 }], affectedRows: 1 },
    { rows: [{ id: 10 }], affectedRows: 1 },
  ]);
  await insertEngine({
    db: new QueryClient(mockPg),
    tableConf,
    dbTables: { customer: tableConf },
    request: {},
    record: { name: 'Mario', email: 'mario@test.it' },
    secondaries,
  });
  return mockPg.calls.map((c) => c.text);
}

describe('upsertKey on the table: the main row', () => {
  it('an insert upserts on it', async () => {
    const [main] = await insert(customerTable({ upsertKey: ['email'] }));
    assert.match(main, /^INSERT INTO "customer" .*ON CONFLICT \("email"\)/);
  });

  it('a bulk upsert upserts on it', async () => {
    const tableConf = customerTable({ upsertKey: ['email'] });
    const mockPg = createMockPg([{ rows: [{ id: 1, _action: 'inserted' }], affectedRows: 1 }]);
    await bulkUpsertEngine({
      db: new QueryClient(mockPg),
      tableConf,
      dbTables: { customer: tableConf },
      request: {},
      items: [{ main: { name: 'Mario', email: 'mario@test.it' } }],
    });
    assert.match(mockPg.calls[0].text, /ON CONFLICT \("email"\)/);
  });

  it('without it, an insert is a plain INSERT', async () => {
    const [main] = await insert(customerTable());
    assert.doesNotMatch(main, /ON CONFLICT/);
  });

  it('does not reach the secondaries: a relation without upsertKey inserts them', async () => {
    const tableConf = customerTable({ upsertKey: ['email'], allowedWriteJoins: [ordersRelation()] });
    const [, child] = await insert(tableConf, { orders: [{ status: 'open', total: 1 }] });
    assert.match(child, /^INSERT INTO "customer_order"/);
    assert.doesNotMatch(child, /ON CONFLICT/);
  });
});

describe('upsertKey on the write relation: the secondaries', () => {
  it('the secondaries upsert on it, with the FK filled in', async () => {
    const tableConf = customerTable({
      allowedWriteJoins: [ordersRelation({ upsertKey: ['customerId', 'status'] })],
    });
    const [main, child] = await insert(tableConf, { orders: [{ status: 'open', total: 1 }] });
    assert.doesNotMatch(main, /ON CONFLICT/);
    assert.match(child, /^INSERT INTO "customer_order" .*ON CONFLICT \("customer_id", "status"\)/);
  });

  it('holds whichever Schema instance the relation was built with', async () => {
    const copy = { ...orderSchema };
    const tableConf = customerTable({
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', copy, 'customerId', { alias: 'orders', upsertKey: ['customerId', 'status'] }),
      ],
    });
    const [, child] = await insert(tableConf, { orders: [{ status: 'open', total: 1 }] });
    assert.match(child, /ON CONFLICT \("customer_id", "status"\)/);
  });
});

describe('upsertKey is checked at startup', () => {
  it('the table key must be a unique key of its schema (ADR 0021)', () => {
    assert.throws(() => customerTable({ upsertKey: ['name'] }), /upsertKey.*'customer'.*\(name\)/s);
  });

  it('the relation key must be a unique key of the joined schema, naming the alias', () => {
    assert.throws(
      () => customerTable({ allowedWriteJoins: [ordersRelation({ upsertKey: ['status'] })] }),
      /upsertKey.*'orders'.*\(status\)/s
    );
  });

  it('a relation upsertKey in allowedReadJoins is refused: reads never write', () => {
    assert.throws(
      () => customerTable({ allowedReadJoins: [ordersRelation({ upsertKey: ['customerId', 'status'] })] }),
      /'orders'.*allowedReadJoins.*upsertKey/s
    );
  });

  it('buildRelation refuses an upsertKey that is not an array of fields of the joined schema', () => {
    assert.throws(() => ordersRelation({ upsertKey: 'status' }), TypeError);
    assert.throws(() => ordersRelation({ upsertKey: ['nope'] }), /'nope'.*customer_order/s);
  });

  it('upsertMap is the pre-1.0 shape: refused, pointing at upsertKey', () => {
    assert.throws(
      () => customerTable({ upsertMap: new Map([[customerSchema, ['email']]]) }),
      /'upsertMap'.*upsertKey/s
    );
  });

  it('buildUpsertRule and buildUpsertRules are no longer exported', () => {
    assert.equal(lib.buildUpsertRule, undefined);
    assert.equal(lib.buildUpsertRules, undefined);
  });
});
