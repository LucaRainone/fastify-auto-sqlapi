// `replace` on a real database: the child rows sent are the complete set, the ones left out
// are deleted (ADR 0029). product → product_translation, keyed (product_id, lang).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECT, createTestApp, cleanTables, seedRows, Type } from './_helpers.js';

const { buildRelation, defineTable } = await import('../../dist/index.js');

function schemaOf(tableName, fields, colMap, primaryKey) {
  return {
    col: (f) => colMap[f] ?? f,
    colMap,
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Partial(Type.Object(fields)),
    primaryKey,
    uniqueKeys: [],
  };
}

const productSchema = schemaOf(
  'product',
  { id: Type.Optional(Type.Integer()), name: Type.String(), price: Type.Number() },
  { id: 'id', name: 'name', price: 'price' },
  ['id'],
);
const translationSchema = schemaOf(
  'product_translation',
  { productId: Type.Integer(), lang: Type.String(), name: Type.String() },
  { productId: 'product_id', lang: 'lang', name: 'name' },
  ['productId', 'lang'],
);

function dbTables(product = {}) {
  return {
    product: defineTable({
      primary: 'id',
      schema: productSchema,
      upsertKey: ['id'],
      writeJoins: [
        buildRelation(productSchema, 'id', translationSchema, 'productId', {
          alias: 'translations', upsertKey: ['productId', 'lang'],
        }),
      ],
      ...product,
    }),
  };
}

describe(`[${DIALECT}] replace on a write join`, () => {
  let app;
  let db;
  let productId;

  before(async () => {
    ({ app, db } = await createTestApp(dbTables(), { prefix: '/auto' }));
  });

  after(async () => {
    await cleanTables(db, ['product_translation', 'product']);
    await app.close();
  });

  beforeEach(async () => {
    await cleanTables(db, ['product_translation', 'product']);
    [{ id: productId }] = await seedRows(db, 'product', [{ name: 'Bike', price: 1 }], 'id');
    await seedRows(db, 'product_translation', [
      { product_id: productId, lang: 'en', name: 'Bike' },
      { product_id: productId, lang: 'it', name: 'Bici' },
    ], 'product_id');
  });

  const translations = async () =>
    (await db.query(
      `SELECT lang, name FROM ${db.qi('product_translation')} WHERE ${db.qi('product_id')} = ${db.ph(1)} ORDER BY lang`,
      [productId],
    )).rows.map((r) => [r.lang, r.name]);

  it('PUT: upserts the rows sent, deletes the ones left out, and reports them', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/product',
      payload: {
        main: { id: productId, name: 'Bike', price: 1 },
        replace: { translations: [{ lang: 'en', name: 'Bicycle' }, { lang: 'de', name: 'Fahrrad' }] },
      },
    });

    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    assert.deepEqual(res.json().deletions, { translations: [{ productId, lang: 'it' }] });
    assert.deepEqual(await translations(), [['de', 'Fahrrad'], ['en', 'Bicycle']]);
  });

  it('PUT: an empty list removes every translation', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/product',
      payload: { main: { id: productId, name: 'Bike', price: 1 }, replace: { translations: [] } },
    });

    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    assert.equal(res.json().deletions.translations.length, 2);
    assert.deepEqual(await translations(), []);
  });

  it('PUT: upsert writes the rows sent and leaves the others', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/product',
      payload: { main: { id: productId, name: 'Bike', price: 2 }, upsert: { translations: [{ lang: 'de', name: 'Fahrrad' }] } },
    });

    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    assert.equal(res.json().deletions, undefined);
    assert.deepEqual(await translations(), [['de', 'Fahrrad'], ['en', 'Bike'], ['it', 'Bici']]);
  });

  it('bulk: replaces each item\'s children', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/product',
      payload: [{
        main: { id: productId, name: 'Bike', price: 1 },
        replace: { translations: [{ lang: 'fr', name: 'Vélo' }] },
      }],
    });

    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    assert.equal(res.json()[0].deletions.translations.length, 2);
    assert.deepEqual(await translations(), [['fr', 'Vélo']]);
  });
});

describe(`[${DIALECT}] replace on a write join — a bulk item is replaced whole or not at all`, () => {
  let app;
  let db;
  let productId;

  before(async () => {
    const failing = dbTables({ afterInsert: () => { throw new Error('audit failed'); } });
    ({ app, db } = await createTestApp(failing, { prefix: '/auto' }));
    await cleanTables(db, ['product_translation', 'product']);
    [{ id: productId }] = await seedRows(db, 'product', [{ name: 'Bike', price: 1 }], 'id');
    await seedRows(db, 'product_translation', [
      { product_id: productId, lang: 'en', name: 'Bike' },
      { product_id: productId, lang: 'it', name: 'Bici' },
    ], 'product_id');
  });

  after(async () => {
    await cleanTables(db, ['product_translation', 'product']);
    await app.close();
  });

  it('an afterInsert failure rolls the item\'s children back: the old set is intact', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/product',
      payload: [{
        main: { id: productId, name: 'Bike', price: 1 },
        replace: { translations: [{ lang: 'fr', name: 'Vélo' }] },
      }],
    });

    assert.equal(res.statusCode, 500, `body: ${res.body}`);
    const rows = (await db.query(
      `SELECT lang FROM ${db.qi('product_translation')} WHERE ${db.qi('product_id')} = ${db.ph(1)} ORDER BY lang`,
      [productId],
    )).rows.map((r) => r.lang);
    assert.deepEqual(rows, ['en', 'it']);
  });
});
