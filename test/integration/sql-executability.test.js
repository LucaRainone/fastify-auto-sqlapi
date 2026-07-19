import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  buildRelation,
  toUnderscore,
  Type,
} from './_helpers.js';

// Unit tests drive the engine against a fake driver, so they can prove which SQL is produced
// but never that the database accepts it. This suite runs a broad matrix of request shapes
// against a real server: any syntax error, ambiguous column or bad placeholder count fails here.
//
// Assertions are deliberately weak on content and strong on executability — the point is
// coverage of query *shapes*, not of results.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { createQueryClient, pgQueryable, mysqlQueryable } = await import(path.join(ROOT, 'dist/index.js'));

function createSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const customerSchema = createSchema('customer', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  isActive: Type.Optional(Type.Boolean()),
  organizationId: Type.Optional(Type.Integer()),
});

const orderSchema = createSchema('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

// Computed fields of both kinds: with and without bound values.
const customerComputed = {
  upperName: ({ qiCol }) => ({
    expr: `UPPER(${qiCol('name')})`,
    values: [],
    type: Type.String(),
  }),
  tier: ({ qiCol }) => ({
    expr: `CASE WHEN ${qiCol('email')} LIKE ? THEN 'vip' ELSE 'std' END`,
    values: ['%vip%'],
    type: Type.String(),
  }),
};

const orderComputed = {
  bigOrder: ({ qiCol }) => ({
    expr: `CASE WHEN ${qiCol('total')} > ? THEN 1 ELSE 0 END`,
    values: [100],
    type: Type.Integer(),
  }),
};

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    computedFields: customerComputed,
    allowedReadJoins: [
      buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' }),
    ],
  },
  customer_order: {
    primary: 'id',
    ...exportTableInfo(orderSchema),
    defaultOrder: 'id',
    computedFields: orderComputed,
    allowedReadJoins: [
      buildRelation(orderSchema, 'customerId', customerSchema, 'id', {
        alias: 'buyer',
        unique: true,
      }),
    ],
  },
};

/**
 * Request shapes to execute. Each is a `searchEngine` params object (minus db/tableConf),
 * paired with the table it runs against.
 */
const SHAPES = [
  ['bare search', 'customer', {}],
  ['plain filter', 'customer', { filters: { name: 'Mario' } }],
  ['multiple filters', 'customer', { filters: { name: 'Mario', isActive: true } }],
  ['computed filter (no values)', 'customer', { filters: { upperName: 'MARIO' } }],
  ['computed filter (bound values)', 'customer', { filters: { tier: 'vip' } }],
  ['computed + plain filter', 'customer', { filters: { name: 'Mario', tier: 'vip' } }],
  ['condition operator', 'customer', { conditions: [{ field: 'id', method: 'isGreater', params: [0] }] }],
  ['condition on computed', 'customer', { conditions: [{ field: 'tier', method: 'isEqual', params: ['vip'] }] }],
  ['condition isIn', 'customer', { conditions: [{ field: 'id', method: 'isIn', params: [[1, 2, 3]] }] }],
  ['condition isBetween', 'customer', { conditions: [{ field: 'id', method: 'isBetween', params: [1, 999999] }] }],
  ['condition isNull', 'customer', { conditions: [{ field: 'email', method: 'isNull', params: [] }] }],
  ['orderBy plain', 'customer', { orderBy: 'name DESC' }],
  ['orderBy multi', 'customer', { orderBy: 'name DESC, id ASC' }],
  ['orderBy computed (no values)', 'customer', { orderBy: 'upperName ASC' }],
  ['orderBy computed (bound values)', 'customer', { orderBy: 'tier DESC' }],
  ['orderBy computed + filter', 'customer', { filters: { name: 'Mario' }, orderBy: 'tier DESC' }],
  ['pagination', 'customer', { paginator: { page: 1, itemsPerPage: 5 } }],
  ['pagination + filter + computed', 'customer', { filters: { name: 'Mario', tier: 'vip' }, paginator: { page: 1, itemsPerPage: 5 } }],
  ['computeMin/Max', 'customer', { paginator: { page: 1, itemsPerPage: 5 }, computeMin: 'id', computeMax: 'id' }],
  ['selectComputed', 'customer', { selectComputed: ['upperName'] }],
  ['maxRows cap', 'customer', { maxRows: 10 }],

  ['joinMultiple', 'customer', { joinMultiple: { orders: {} } }],
  ['joinMultiple + filter', 'customer', { joinMultiple: { orders: { filters: { status: 'pending' } } } }],
  ['joinMultiple + computed filter', 'customer', { joinMultiple: { orders: { filters: { bigOrder: 1 } } } }],
  ['joinMultiple + selection', 'customer', { joinMultiple: { orders: { selection: 'id,total' } } }],
  ['joinMultiple + condition', 'customer', { joinMultiple: { orders: { conditions: [{ field: 'total', method: 'isGreater', params: [0] }] } } }],

  ['joinMustExist', 'customer', { joinMustExist: { orders: {} } }],
  ['joinMustExist + filter', 'customer', { joinMustExist: { orders: { filters: { status: 'pending' } } } }],
  ['joinMustExist + computed filter', 'customer', { joinMustExist: { orders: { filters: { bigOrder: 1 } } } }],
  ['joinMustExist + outer filter', 'customer', { filters: { name: 'Mario' }, joinMustExist: { orders: { filters: { status: 'pending' } } } }],
  ['joinMustExist + computed both sides', 'customer', { filters: { tier: 'vip' }, joinMustExist: { orders: { filters: { bigOrder: 1 } } } }],

  ['joinGroup sum', 'customer', { joinGroup: { orders: { aggregations: { sum: ['total'] } } } }],
  ['joinGroup by', 'customer', { joinGroup: { orders: { aggregations: { by: 'status', sum: ['total'], count: ['id'] } } } }],
  ['joinGroup + filter', 'customer', { joinGroup: { orders: { aggregations: { sum: ['total'] }, filters: { status: 'pending' } } } }],
  ['joinGroup + computed filter', 'customer', { joinGroup: { orders: { aggregations: { sum: ['total'] }, filters: { bigOrder: 1 } } } }],

  ['joinLeft', 'customer_order', { joinLeft: { buyer: {} } }],
  ['joinLeft + parent filter', 'customer_order', { joinLeft: { buyer: { filters: { name: 'Mario' } } } }],
  ['joinLeft + parent computed filter', 'customer_order', { joinLeft: { buyer: { filters: { tier: 'vip' } } } }],
  ['joinLeft + 2-part orderBy', 'customer_order', { joinLeft: { buyer: {} }, orderBy: 'buyer.name ASC' }],
  ['joinLeft + selection', 'customer_order', { joinLeft: { buyer: { selection: 'id,name' } } }],
  ['joinLeft + outer filter + orderBy', 'customer_order', { filters: { status: 'pending' }, joinLeft: { buyer: { filters: { name: 'Mario' } } }, orderBy: 'buyer.name DESC' }],

  ['aggregation orderBy (3-part)', 'customer', {
    joinGroup: { orders: { aggregations: { sum: ['total'] } } },
    orderBy: 'orders.sum.total DESC',
  }],
  ['aggregation orderBy + filtered joinLeft-free', 'customer', {
    filters: { name: 'Mario' },
    joinGroup: { orders: { aggregations: { sum: ['total'] } } },
    orderBy: 'orders.sum.total DESC',
  }],

  ['everything at once', 'customer', {
    filters: { isActive: true, tier: 'vip' },
    conditions: [{ field: 'id', method: 'isGreater', params: [0] }],
    joinMustExist: { orders: { filters: { status: 'pending' } } },
    joinMultiple: { orders: { filters: { bigOrder: 1 } } },
    joinGroup: { orders: { aggregations: { by: 'status', sum: ['total'] } } },
    orderBy: 'tier DESC, name ASC',
    paginator: { page: 1, itemsPerPage: 5 },
    computeMin: 'id',
  }],
];

describe(`[${DIALECT}] generated SQL executes on a real database`, () => {
  let app;
  let db;
  let engineDb;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    engineDb = db;

    await cleanTables(db, ['customer_order', 'customer']);
    const customers = await seedRows(db, 'customer', [
      { name: 'Mario', email: 'mario+vip@test.it', is_active: true },
      { name: 'Luigi', email: 'luigi@test.it', is_active: false },
    ]);
    await seedRows(db, 'customer_order', [
      { customer_id: customers[0].id, total: 250.0, status: 'pending', notes: 'n1' },
      { customer_id: customers[1].id, total: 50.0, status: 'shipped', notes: 'n2' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  for (const [label, table, params] of SHAPES) {
    it(`executes: ${label}`, async () => {
      const result = await searchEngine(DbTables, {
        db: engineDb,
        tableConf: DbTables[table],
        ...params,
      });
      // The database accepted the statement and the engine shaped a result.
      assert.ok(result && Array.isArray(result.main), `no result for shape: ${label}`);
    });
  }

  it('covers every join family and both computed kinds', () => {
    const all = JSON.stringify(SHAPES);
    for (const token of ['joinMultiple', 'joinMustExist', 'joinGroup', 'joinLeft', 'tier', 'upperName', 'bigOrder']) {
      assert.ok(all.includes(token), `matrix lost coverage of ${token}`);
    }
  });
});
