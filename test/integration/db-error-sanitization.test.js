// A real constraint violation, end-to-end over HTTP against a real database: the driver
// message names the constraint (`product_pkey` on Postgres, `PRIMARY` on MySQL) and must
// not reach the client. The `exposeDebugInfo` app is the control — same request, same
// violation, detail present — so the test proves the sanitizer is what removes it and not
// that the scenario failed to produce a leak. ADR 0013.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  Type,
} from './_helpers.js';

const productFields = {
  id: Type.Integer(),
  name: Type.String(),
  price: Type.Number(),
};

const productSchema = {
  col: (f) => f,
  colMap: { id: 'id', name: 'name', price: 'price' },
  fields: productFields,
  validation: Type.Object(productFields),
  tableName: 'product',
  partialValidation: Type.Partial(Type.Object(productFields)),
};

// `id` is deliberately NOT in excludeFromCreation: the client sends it, so an existing
// value hits the primary key and the database raises a unique violation.
const DbTables = {
  product: {
    primary: 'id',
    ...exportTableInfo(productSchema),
    defaultOrder: 'id',
  },
};

describe(`[${DIALECT}] a real constraint violation does not describe the schema`, () => {
  let app;
  let debugApp;
  let db;
  let takenId;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    ({ app: debugApp } = await createTestApp(DbTables, {
      prefix: '/auto',
      exposeDebugInfo: true,
    }));
    await cleanTables(db, ['product']);
    const [row] = await seedRows(db, 'product', [{ name: 'Bike', price: 100 }], 'id');
    takenId = row.id;
  });

  after(async () => {
    await cleanTables(db, ['product']);
    await app.close();
    await debugApp.close();
  });

  const duplicate = () => ({
    method: 'POST',
    url: '/auto/rest/product',
    payload: { main: { id: takenId, name: 'Clone', price: 50 } },
  });

  it('the unique violation answers a bare 500', async () => {
    const res = await app.inject(duplicate());

    assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().message, 'Internal Server Error');
    for (const leak of ['product_pkey', 'duplicate key', 'Duplicate entry', 'PRIMARY']) {
      assert.ok(!res.body.includes(leak), `"${leak}" leaked to the client: ${res.body}`);
    }
  });

  it('control: the same request under exposeDebugInfo does carry the driver detail', async () => {
    const res = await debugApp.inject(duplicate());
    const body = res.json();

    assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
    // The contract fields are the production ones — the detail arrives beside them.
    assert.equal(body.message, 'Internal Server Error');
    const detail = JSON.stringify(body.debugInfo);
    const leaked = ['product_pkey', 'duplicate key', 'Duplicate entry', 'PRIMARY']
      .some((marker) => detail.includes(marker));
    assert.ok(leaked, `the scenario produced no driver detail to sanitize: ${res.body}`);
  });
});
