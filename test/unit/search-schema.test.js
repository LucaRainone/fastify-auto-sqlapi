import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { SearchTableBodyPost, SearchTableQueryString, SearchTableResponse } =
  await import(path.join(ROOT, 'dist/lib/search-schema.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { Type } = await import('@sinclair/typebox');

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

function createDbTables() {
  const customerSchema = createMockSchema('customer', {
    id: Type.Number(),
    name: Type.String(),
    email: Type.String(),
  });
  const orderSchema = createMockSchema('customer_order', {
    id: Type.Number(),
    customerId: Type.Number(),
    total: Type.Number(),
  });

  const customerInfo = exportTableInfo(customerSchema, { isActive: Type.Boolean() });
  const orderInfo = exportTableInfo(orderSchema);

  return {
    customer: {
      primary: 'id',
      ...customerInfo,
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
    },
    customer_order: {
      primary: 'id',
      ...orderInfo,
      defaultOrder: 'id',
    },
  };
}

describe('SearchTableBodyPost', () => {
  it('generates schema with filters property', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    assert.ok(schema.properties.filters);
  });

  it('includes schema fields and extraFilters in filters', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    // filters wraps Partial(Object({id, name, email, isActive}))
    const filtersSchema = schema.properties.filters;
    assert.ok(filtersSchema);
  });

  it('includes joins and joinGroups for tables with allowedReadJoins', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    assert.ok(schema.properties.joins);
    assert.ok(schema.properties.joinGroups);
  });

  it('does not include joins for tables without allowedReadJoins', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer_order');

    assert.equal(schema.properties.joins, undefined);
    assert.equal(schema.properties.joinGroups, undefined);
  });

  it('joinGroups includes aggregation fields', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    // Dig into joinGroups -> customer_order -> aggregations
    const joinGroupsSchema = schema.properties.joinGroups;
    assert.ok(joinGroupsSchema);
  });
});

describe('SearchTableQueryString', () => {
  it('has expected fields', () => {
    assert.ok(SearchTableQueryString.properties.orderBy);
    assert.ok(SearchTableQueryString.properties.page);
    assert.ok(SearchTableQueryString.properties.itemsPerPage);
    assert.ok(SearchTableQueryString.properties.computeMin);
    assert.ok(SearchTableQueryString.properties.computeMax);
    assert.ok(SearchTableQueryString.properties.computeSum);
    assert.ok(SearchTableQueryString.properties.computeAvg);
  });
});

describe('SearchTableResponse', () => {
  it('has table, main, joins, joinGroups, pagination', () => {
    const dbTables = createDbTables();
    const schema = SearchTableResponse(dbTables, 'customer');

    assert.ok(schema.properties.table);
    assert.ok(schema.properties.main);
    assert.ok(schema.properties.joins);
    assert.ok(schema.properties.joinGroups);
    assert.ok(schema.properties.pagination);
  });

  it('main is an array', () => {
    const dbTables = createDbTables();
    const schema = SearchTableResponse(dbTables, 'customer');

    // main should be Type.Array(...)
    assert.equal(schema.properties.main.type, 'array');
  });

  it('joins includes join table arrays', () => {
    const dbTables = createDbTables();
    const schema = SearchTableResponse(dbTables, 'customer');

    assert.ok(schema.properties.joins.properties.customer_order);
    assert.equal(schema.properties.joins.properties.customer_order.type, 'array');
  });
});
