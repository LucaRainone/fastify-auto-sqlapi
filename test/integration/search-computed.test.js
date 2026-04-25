import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  toUnderscore,
  Type,
} from './_helpers.js';

function createSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const productSchema = createSchema('product', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  price: Type.Optional(Type.Number()),
  metadata: Type.Optional(Type.Any()),
});

const productInfo = exportTableInfo(productSchema);

const DbTables = {
  product: {
    primary: 'id',
    ...productInfo,
    defaultOrder: 'id',
    computedFields: {
      // Extract a JSON field — dialect-aware.
      productTier: ({ db, qiCol }) => ({
        expr: db.dialectName === 'postgres'
          ? `${qiCol('metadata')}->>'tier'`
          : `JSON_UNQUOTE(JSON_EXTRACT(${qiCol('metadata')}, '$.tier'))`,
        values: [],
        type: Type.String(),
      }),
      // Derived string column — concat is `||` on Postgres, CONCAT() on MySQL.
      label: ({ db, qiCol }) => ({
        expr: db.dialectName === 'postgres'
          ? `${qiCol('name')} || ' - ' || COALESCE(${qiCol('description')}, '')`
          : `CONCAT(${qiCol('name')}, ' - ', COALESCE(${qiCol('description')}, ''))`,
        values: [],
        type: Type.String(),
      }),
    },
  },
};

describe(`[${DIALECT}] computed fields integration`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    await cleanTables(db, ['product']);

    await seedRows(db, 'product', [
      { name: 'Premium Coffee', description: 'Single-origin', price: 25, metadata: JSON.stringify({ tier: 'premium' }) },
      { name: 'Basic Tea',      description: 'Black tea',     price: 5,  metadata: JSON.stringify({ tier: 'basic' }) },
      { name: 'Premium Mug',    description: 'Ceramic',       price: 15, metadata: JSON.stringify({ tier: 'premium' }) },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('filters by computed (JSON-extracted)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/product',
      payload: { filters: { productTier: 'premium' } },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
    assert.ok(body.main.every((p) => p.name.includes('Premium')));
  });

  it('orderBy by computed (concat)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/product?orderBy=label+ASC',
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // Alphabetical by label: "Basic Tea …", "Premium Coffee …", "Premium Mug …"
    assert.equal(body.main[0].name, 'Basic Tea');
    assert.equal(body.main[1].name, 'Premium Coffee');
    assert.equal(body.main[2].name, 'Premium Mug');
  });

  it('selectComputed projects computed values into main rows', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/product?orderBy=name+ASC',
      payload: { selectComputed: ['productTier', 'label'] },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 3);
    assert.equal(body.main[0].productTier, 'basic');
    assert.equal(body.main[0].label, 'Basic Tea - Black tea');
    assert.equal(body.main[1].productTier, 'premium');
  });

  it('conditions with operator on computed (isLike on label)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/product',
      payload: {
        conditions: [
          // Use isLike (cross-dialect) — MySQL LIKE is case-insensitive by default collation.
          { field: 'label', method: 'isLike', params: ['%Premium%'] },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
  });

  it('rejects selectComputed with unknown name (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/product',
      payload: { selectComputed: ['bogus'] },
    });
    assert.equal(res.statusCode, 400);
  });
});
