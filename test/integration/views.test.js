// Views, end to end on a real engine.
//
// A view is a table config like any other and searching one works with no special support —
// that part is asserted here so it stays true. What needs care is what the generator may
// assume: the database reports no PRIMARY KEY for a view, so a key must never be invented in
// silence, and only a view the engine can make updatable accepts a write.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIALECT, PG_CONNECTION_STRING, MYSQL_CONFIG, createTestApp, cleanTables, seedRows,
} from './_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { introspectTables } = await import(path.join(ROOT, 'dist/lib/cli/pg-introspect.js'));
const { introspectMysqlTables } = await import(path.join(ROOT, 'dist/lib/cli/mysql-introspect.js'));
const { buildTableMap } = await import(path.join(ROOT, 'dist/lib/cli/schema-codegen.js'));
const { generateSingleTableFile } = await import(path.join(ROOT, 'dist/lib/cli/tables-codegen.js'));
const { defineTable, exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type, Nullable } = await import(path.join(ROOT, 'dist/index.js'));

function introspect() {
  return DIALECT === 'postgres'
    ? introspectTables(PG_CONNECTION_STRING, 'public')
    : introspectMysqlTables(MYSQL_CONFIG, MYSQL_CONFIG.database);
}

describe(`[${DIALECT}] introspection of views`, () => {
  it('sees a view alongside the base tables', async () => {
    const rows = await introspect();
    const tables = [...new Set(rows.map((r) => r.table_name))];
    assert.ok(tables.includes('customer_summary'));
    assert.ok(tables.includes('customer'));
  });

  it('flags the view and leaves base tables unflagged', async () => {
    const rows = await introspect();
    const viewCol = rows.find((r) => r.table_name === 'customer_summary' && r.column_name === 'id');
    const tableCol = rows.find((r) => r.table_name === 'customer' && r.column_name === 'id');
    assert.equal(viewCol.is_view, true);
    assert.ok(!tableCol.is_view);
  });

  it('reports no primary key on a view — none is declared in the database', async () => {
    const rows = await introspect();
    const viewCols = rows.filter((r) => r.table_name === 'customer_summary');
    assert.ok(viewCols.length > 0);
    assert.ok(viewCols.every((r) => !r.is_primary));
  });

  it('exposes every column of the view, aggregates included', async () => {
    const map = buildTableMap(await introspect());
    const fields = Object.keys(map.SchemaCustomerSummary.fields);
    assert.deepEqual(fields, ['id', 'name', 'email', 'orderCount', 'totalSpent']);
    assert.equal(map.SchemaCustomerSummary.isView, true);
  });
});

if (DIALECT === 'postgres') {
  describe('[postgres] introspection of materialized views', () => {
    it('finds a materialized view, which information_schema does not describe', async () => {
      const rows = await introspect();
      const cols = rows.filter((r) => r.table_name === 'product_stock');
      assert.ok(cols.length > 0, 'product_stock should be introspected');
      assert.deepEqual(cols.map((c) => c.column_name), ['id', 'name', 'quantity']);
    });

    it('treats it as a view', async () => {
      const rows = await introspect();
      assert.ok(rows.filter((r) => r.table_name === 'product_stock').every((r) => r.is_view));
    });

    it('generates a usable schema for it', async () => {
      const map = buildTableMap(await introspect());
      assert.equal(map.SchemaProductStock.isView, true);
      assert.ok(map.SchemaProductStock.fields.quantity);
    });
  });
}

describe(`[${DIALECT}] table config generated for a view`, () => {
  it('says the key was inferred when the view carries an id', async () => {
    const map = buildTableMap(await introspect());
    const t = map.SchemaCustomerSummary;
    const out = generateSingleTableFile({
      schemaName: 'SchemaCustomerSummary',
      tableName: t.name,
      fields: Object.keys(t.fields),
      fieldTypes: t.fields,
      primary: t.primary.length ? t.primary : undefined,
      isView: t.isView,
    }, []);

    assert.match(out, /primary: 'id'/);
    assert.match(out, /is a VIEW/);
    assert.match(out, /operations: \['search', 'get'\]/);
  });

  it('refuses to invent a key for a view that has none', async () => {
    const map = buildTableMap(await introspect());
    const t = map.SchemaOrderStatusCount;
    const out = generateSingleTableFile({
      schemaName: 'SchemaOrderStatusCount',
      tableName: t.name,
      fields: Object.keys(t.fields),
      fieldTypes: t.fields,
      primary: t.primary.length ? t.primary : undefined,
      isView: t.isView,
    }, []);

    // orderCount is an integer column, which the base-table heuristic would have taken.
    assert.doesNotMatch(out, /primary: 'orderCount'/);
    assert.match(out, /primary: 'TODO/);
    assert.match(out, /operations: \['search'\]/);
    assert.match(out, /defaultOrder: 'status'/);
  });
});

// The Schema mirrors what the generator emits for customer_summary.
const summaryFields = {
  id: Type.Optional(Nullable(Type.Integer())),
  name: Type.Optional(Nullable(Type.String())),
  email: Type.Optional(Nullable(Type.String())),
  orderCount: Type.Optional(Nullable(Type.Integer())),
  totalSpent: Type.Optional(Nullable(Type.Integer())),
};
const summaryColMap = {
  id: 'id', name: 'name', email: 'email', orderCount: 'order_count', totalSpent: 'total_spent',
};
const SchemaCustomerSummary = {
  col: (f) => summaryColMap[f] ?? f,
  colMap: summaryColMap,
  fields: summaryFields,
  validation: Type.Object(summaryFields, { $id: 'SchemaCustomerSummary' }),
  partialValidation: Type.Object(summaryFields, {
    additionalProperties: false, $id: 'PartialSchemaCustomerSummary',
  }),
  tableName: 'customer_summary',
  isView: true,
};

const DbTables = {
  customer_summary: defineTable({
    primary: 'id',
    ...exportTableInfo(SchemaCustomerSummary),
    defaultOrder: 'id',
    operations: ['search', 'get'],
  }),
};

describe(`[${DIALECT}] serving a view over HTTP`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    await cleanTables(db, ['customer_order', 'customer']);
    const ids = await seedRows(db, 'customer', [
      { name: 'Mario', email: 'mario@test.it', is_active: true },
      { name: 'Luigi', email: 'luigi@test.it', is_active: true },
    ]);
    await seedRows(db, 'customer_order', [
      { customer_id: ids[0].id, total: 100, status: 'pending' },
      { customer_id: ids[0].id, total: 50, status: 'pending' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('searches the view, aggregates included', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_summary',
      payload: {},
    });

    assert.equal(res.statusCode, 200, res.body);
    const mario = res.json().main.find((r) => r.name === 'Mario');
    assert.equal(mario.orderCount, 2);
    assert.equal(Number(mario.totalSpent), 150);
  });

  it('filters and orders on an aggregated column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_summary?orderBy=orderCount DESC',
      payload: { conditions: [{ field: 'orderCount', method: 'isGreater', params: [0] }] },
    });

    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json().main;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Mario');
  });

  it('paginates the view', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_summary?page=1&itemsPerPage=1',
      payload: {},
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().main.length, 1);
    assert.equal(res.json().pagination.total, 2);
  });

  it('gets a single row of the view by the inferred key', async () => {
    const search = await app.inject({
      method: 'POST', url: '/auto/search/customer_summary', payload: {},
    });
    const id = search.json().main[0].id;

    const res = await app.inject({ method: 'GET', url: `/auto/rest/customer_summary/${id}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().main.id, id);
  });

  it('does not expose the write routes the config left off', async () => {
    const insert = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer_summary',
      payload: { main: { name: 'Nope' } },
    });
    assert.equal(insert.statusCode, 404, insert.body);

    const del = await app.inject({ method: 'DELETE', url: '/auto/rest/customer_summary/1' });
    assert.equal(del.statusCode, 404, del.body);
  });
});

// A simple view PostgreSQL and MySQL both make updatable on their own. Writing through a view
// is a legitimate pattern — a projection or a permission layer — and the plugin must keep
// serving it: only the generated template starts read-only, the runtime imposes nothing.
// The flag the view filters on is deliberately not exposed: a projection layer that hides it
// is the point of writing through a view. `customer.is_active` defaults to true on both
// dialects, so a row inserted here lands inside the view's predicate.
const activeFields = {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Nullable(Type.String())),
  email: Type.Optional(Nullable(Type.String())),
};
const activeColMap = { id: 'id', name: 'name', email: 'email' };
const SchemaCustomerActive = {
  col: (f) => activeColMap[f] ?? f,
  colMap: activeColMap,
  fields: activeFields,
  validation: Type.Object(activeFields, { $id: 'SchemaCustomerActive' }),
  partialValidation: Type.Object(activeFields, {
    additionalProperties: false, $id: 'PartialSchemaCustomerActive',
  }),
  tableName: 'customer_active',
  isView: true,
};

describe(`[${DIALECT}] writing through an updatable view`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp({
      customer_active: defineTable({
        primary: 'id',
        ...exportTableInfo(SchemaCustomerActive),
        defaultOrder: 'id',
        excludeFromCreation: ['id'],
      }),
    }, { prefix: '/auto' }));
    await cleanTables(db, ['customer_order', 'customer']);
  });

  after(async () => {
    await app.close();
  });

  it('inserts through the view when the config allows it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer_active',
      payload: { main: { name: 'Peach', email: 'peach@test.it' } },
    });

    assert.equal(res.statusCode, 201, res.body);
    const rows = await db.select({
      tableName: 'customer', where: 'name = ' + db.ph(1), values: ['Peach'],
    });
    assert.equal(rows.length, 1);
  });

  it('updates through the view', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer_active',
      payload: { main: { name: 'Toad', email: 'toad@test.it' } },
    });
    const id = created.json().main.id;

    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/customer_active',
      payload: { main: { id, email: 'toad+new@test.it' } },
    });

    assert.equal(res.statusCode, 200, res.body);
    const read = await app.inject({ method: 'GET', url: `/auto/rest/customer_active/${id}` });
    assert.equal(read.json().main.email, 'toad+new@test.it');
  });
});

// The config the generator writes for a view whose key it could not infer, verbatim. It must
// be a working config, not a broken one waiting to be fixed: search never reads `primary`, it
// reads `defaultOrder`. If this stops passing, the TODO placeholder became a trap.
const statusFields = {
  status: Type.Optional(Nullable(Type.String())),
  orderCount: Type.Optional(Nullable(Type.Integer())),
};
const statusColMap = { status: 'status', orderCount: 'order_count' };
const SchemaOrderStatusCount = {
  col: (f) => statusColMap[f] ?? f,
  colMap: statusColMap,
  fields: statusFields,
  validation: Type.Object(statusFields, { $id: 'SchemaOrderStatusCount' }),
  partialValidation: Type.Object(statusFields, {
    additionalProperties: false, $id: 'PartialSchemaOrderStatusCount',
  }),
  tableName: 'order_status_count',
  isView: true,
};

describe(`[${DIALECT}] a view whose primary key could not be inferred`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp({
      order_status_count: defineTable({
        primary: 'TODO_pick_a_unique_column',
        ...exportTableInfo(SchemaOrderStatusCount),
        defaultOrder: 'status',
        operations: ['search'],
      }),
    }, { prefix: '/auto' }));
    await cleanTables(db, ['customer_order', 'customer']);
    const ids = await seedRows(db, 'customer', [{ name: 'Mario', email: 'm@t.it' }]);
    await seedRows(db, 'customer_order', [
      { customer_id: ids[0].id, total: 10, status: 'pending' },
      { customer_id: ids[0].id, total: 20, status: 'pending' },
      { customer_id: ids[0].id, total: 30, status: 'shipped' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('registers and searches without ever resolving the placeholder', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auto/search/order_status_count', payload: {},
    });

    assert.equal(res.statusCode, 200, res.body);
    const pending = res.json().main.find((r) => r.status === 'pending');
    assert.equal(pending.orderCount, 2);
  });

  it('orders by the declared defaultOrder, not by the placeholder', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auto/search/order_status_count?page=1&itemsPerPage=10', payload: {},
    });

    assert.equal(res.statusCode, 200, res.body);
    const statuses = res.json().main.map((r) => r.status);
    assert.deepEqual(statuses, [...statuses].sort());
  });

  it('does not expose the routes that would need the placeholder', async () => {
    const get = await app.inject({ method: 'GET', url: '/auto/rest/order_status_count/1' });
    assert.equal(get.statusCode, 404, get.body);
  });
});
