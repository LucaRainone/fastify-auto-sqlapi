// Integration test for composite primary keys, end-to-end over HTTP + real DB.
// Reproduces (and locks down the fix for) the reported 500 on MySQL where writing a
// composite-PK table returned only the first PK column, breaking response serialization
// (the response schema requires every PK field). Also covers UPDATE matching on ALL pk
// columns (a single-column WHERE would touch every row sharing the first PK value).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  Type,
} from './_helpers.js';

const translationFields = {
  productId: Type.Integer(),
  lang: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
};

const translationColMap = {
  productId: 'product_id',
  lang: 'lang',
  name: 'name',
  description: 'description',
};

const translationSchema = {
  col: (f) => translationColMap[f] ?? f,
  colMap: translationColMap,
  fields: translationFields,
  validation: Type.Object(translationFields),
  tableName: 'product_translation',
  partialValidation: Type.Partial(Type.Object(translationFields)),
};

const productFields = {
  id: Type.Optional(Type.Integer()),
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

const DbTables = {
  product: {
    primary: 'id',
    ...exportTableInfo(productSchema),
    defaultOrder: 'id',
    excludeFromCreation: ['id'],
  },
  product_translation: {
    primary: ['productId', 'lang'],
    ...exportTableInfo(translationSchema),
    defaultOrder: 'productId',
  },
};

describe(`[${DIALECT}] composite primary key — end-to-end`, () => {
  let app;
  let db;
  let productId;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    await cleanTables(db, ['product_translation', 'product']);
    const [row] = await seedRows(db, 'product', [{ name: 'Bike', price: 100 }], 'id');
    productId = row.id;
  });

  after(async () => {
    await cleanTables(db, ['product_translation', 'product']);
    await app.close();
  });

  beforeEach(async () => {
    await cleanTables(db, ['product_translation']);
  });

  it('POST insert returns the FULL composite PK (no 500)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/product_translation',
      payload: { main: { productId, lang: 'en', name: 'Mountain Bike' } },
    });

    assert.equal(res.statusCode, 201, `body: ${res.body}`);
    const body = res.json();
    assert.equal(body.main.productId, productId);
    assert.equal(body.main.lang, 'en', 'lang (2nd PK column) must be present in the response');
  });

  it('PUT update matches on ALL pk columns (does not touch sibling rows)', async () => {
    // Two translations share the same productId but differ by lang.
    await seedRows(db, 'product_translation', [
      { product_id: productId, lang: 'en', name: 'EN name' },
      { product_id: productId, lang: 'it', name: 'IT name' },
    ], 'product_id');

    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/product_translation',
      payload: { main: { productId, lang: 'en', name: 'EN updated' } },
    });

    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    const body = res.json();
    assert.equal(body.main.productId, productId);
    assert.equal(body.main.lang, 'en');

    // The 'it' row must be untouched — a single-column WHERE would have hit it too.
    const rows = await db.query(
      `SELECT lang, name FROM ${db.qi('product_translation')} WHERE ${db.qi('product_id')} = ${db.ph(1)} ORDER BY lang`,
      [productId]
    );
    const byLang = Object.fromEntries(rows.rows.map((r) => [r.lang, r.name]));
    assert.equal(byLang.en, 'EN updated');
    assert.equal(byLang.it, 'IT name', 'sibling translation must be untouched');
  });

  it('PUT bulk upsert returns the FULL composite PK for every item', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/product_translation',
      payload: [
        { main: { productId, lang: 'en', name: 'EN' } },
        { main: { productId, lang: 'it', name: 'IT' } },
      ],
    });

    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    const body = res.json();
    assert.equal(body.length, 2);
    for (const item of body) {
      assert.equal(item.main.productId, productId);
      assert.ok(item.main.lang === 'en' || item.main.lang === 'it', 'each item must carry its lang');
    }
  });
});
