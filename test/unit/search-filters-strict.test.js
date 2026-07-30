import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { SearchTableBodyPost } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { searchRoutes } = await import(path.join(ROOT, 'dist/index.js'));
const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

// A filter key the engine does not recognise used to be dropped in silence: the request
// came back with MORE rows than the caller asked for, and nothing said so. Write paths have
// always rejected unknown keys (see write-schema-strict.test.js); reads must match.

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

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

function createDbTables() {
  // `customer` carries an extraFilter; `customer_order` joins it both ways:
  //  - alias 'orders'   (unique:false) → joinMustExist / joinMultiple / joinGroup
  //  - alias 'customer' (unique:true)  → joinLeft
  const customerInfo = exportTableInfo(
    customerSchema,
    { nameLike: Type.String() },
    (condition, filters) => {
      if (filters.nameLike !== undefined) condition.isLike('"customer"."name"', filters.nameLike);
    }
  );
  const orderInfo = exportTableInfo(orderSchema);

  return {
    customer: {
      primary: 'id',
      ...customerInfo,
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...orderInfo,
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(orderSchema, 'customerId', customerSchema, 'id', {
          alias: 'customer',
          unique: true,
          selection: 'id, name',
        }),
        // Same target, unique:false — reached through buildJoinRefCondition, which does
        // run the target's extendedCondition. Contrasts with the joinLeft alias above.
        buildRelation(orderSchema, 'customerId', customerSchema, 'id', {
          alias: 'customerRef',
        }),
      ],
    },
  };
}

describe('search filters schema stays open so the engine can reject unknown keys', () => {
  // Fastify runs Ajv with removeAdditional:true. A closed filters schema would STRIP an
  // unknown key before the handler runs — a 200 with unfiltered rows, i.e. the exact bug —
  // and the engine's 400 would become unreachable over HTTP. These guard that regression.
  const closed = (o) => o.additionalProperties === false;

  it('main filters is not closed', () => {
    const schema = SearchTableBodyPost(createDbTables(), 'customer');
    assert.ok(!closed(schema.properties.filters), 'additionalProperties:false would strip, not reject');
  });

  it('joinMustExist / joinMultiple / joinGroup filters are not closed', () => {
    const schema = SearchTableBodyPost(createDbTables(), 'customer');
    assert.ok(!closed(schema.properties.joinMustExist.properties.orders.properties.filters));
    assert.ok(!closed(schema.properties.joinMultiple.properties.orders.properties.filters));
    assert.ok(!closed(schema.properties.joinGroup.properties.orders.properties.filters));
  });

  it('joinLeft filters is not closed', () => {
    const schema = SearchTableBodyPost(createDbTables(), 'customer_order');
    assert.ok(!closed(schema.properties.joinLeft.properties.customer.properties.filters));
  });

  it('main filters still advertises the table extraFilters', () => {
    const schema = SearchTableBodyPost(createDbTables(), 'customer');
    assert.ok(schema.properties.filters.properties.nameLike, 'nameLike must stay filterable');
  });

  it('joinMultiple filters advertises the join table extraFilters', () => {
    // buildJoinRefCondition delegates to joinTableConf.filters(), which runs extendedCondition.
    const schema = SearchTableBodyPost(createDbTables(), 'customer_order');
    const filters = schema.properties.joinMultiple.properties.customerRef.properties.filters;
    assert.ok(filters.properties.nameLike, 'extraFilters are applied on unique:false joins');
  });

  it('joinLeft filters does NOT advertise the parent extraFilters', () => {
    // buildLeftJoinClauses only handles schema fields and computed fields: an extraFilter
    // key would be accepted by the schema and then silently ignored by the engine.
    const schema = SearchTableBodyPost(createDbTables(), 'customer_order');
    const joinLeftFilters = schema.properties.joinLeft.properties.customer.properties.filters;
    assert.equal(
      joinLeftFilters.properties.nameLike,
      undefined,
      'extraFilters are not applied on joinLeft — the schema must not promise them'
    );
    assert.ok(joinLeftFilters.properties.name, 'schema fields stay filterable on joinLeft');
  });
});

// pg-shaped pool. Answers every query with a well-formed empty page, so a request that
// gets past validation reaches a 200 instead of blowing up on an exhausted mock: the
// unknown-key tests must fail on the status code, not on a missing canned response.
function createMockPool() {
  const calls = [];
  return {
    calls,
    query(text, values) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: normalized, values });
      return Promise.resolve(
        /\bCOUNT\(/i.test(normalized)
          ? { rows: [{ total: '0' }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      );
    },
  };
}

async function buildApp(pool) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(searchRoutes, { DbTables: createDbTables() });
  await app.ready();
  return app;
}

describe('search filters reject unknown keys (over HTTP)', () => {
  it('unknown main filter key is a 400, not a silently unfiltered result', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/search/customer',
      payload: { filters: { nosuchfield: 'x' } },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(pool.calls.length, 0, 'no query must reach the database');

    await app.close();
  });

  it('unknown joinLeft filter key is a 400', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/search/customer_order',
      payload: { joinLeft: { customer: { filters: { nosuchfield: 'x' } } } },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(pool.calls.length, 0, 'no query must reach the database');

    await app.close();
  });

  it('an extraFilter on joinLeft is a 400 that names the reason', async () => {
    // buildLeftJoinClauses never runs the parent's extendedCondition: accepting the key
    // would apply no condition at all and quietly widen the result.
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/search/customer_order',
      payload: { joinLeft: { customer: { filters: { nameLike: 'Mar%' } } } },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.match(res.json().message, /extraFilters are not applied on joinLeft/);

    await app.close();
  });

  it('the same extraFilter on the unique:false relation still works', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/search/customer_order',
      payload: { joinMustExist: { customerRef: { filters: { nameLike: 'Mar%' } } } },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    await app.close();
  });

  it('unknown joinMultiple filter key is a 400', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/search/customer',
      payload: { joinMultiple: { orders: { filters: { nosuchfield: 1 } } } },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(pool.calls.length, 0, 'no query must reach the database');

    await app.close();
  });

  it('the programmatic path rejects it too, not just the route', async () => {
    // The check lives in the engine precisely so sqlApi.search() is covered: a route-schema
    // guard would leave consumer code calling the engine directly on the old behaviour.
    const db = new QueryClient(createMockPool());
    const DbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        filters: { nosuchfield: 'x' },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Unknown filter field: nosuchfield/);
        return true;
      }
    );
  });

  it('an undefined filter value is not a wrong filter', async () => {
    // `undefined` means "not supplied" everywhere else in the engine; spreading an optional
    // value into a filters object must not become a 400.
    const db = new QueryClient(createMockPool());
    const DbTables = createDbTables();

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      filters: { name: 'Mario', nosuchfield: undefined },
    });

    assert.ok(result.main);
  });

  it('a known filter and a known extraFilter still pass', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/search/customer',
      payload: { filters: { name: 'Mario', nameLike: 'Mar%' } },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.ok(pool.calls.length > 0, 'the request must reach the database');

    await app.close();
  });
});
