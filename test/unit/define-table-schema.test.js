// A table config is one flat object: `defineTable({ primary, schema, extraFilters,
// extendedCondition, ... })`. The pre-1.0 spread of `exportTableInfo()` (which produced
// `Schema`, `filters` and `extraFilters`) is gone, and so is the PascalCase `DbTables` plugin
// option: the old shapes fail at startup naming the new one, never silently.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const lib = await import(path.join(ROOT, 'dist/index.js'));
const { fastifyAutoSqlApi, defineTable, createSqlApi, Type } = lib;

const SchemaOrder = createMockSchema('customer_order', {
  id: Type.Integer(),
  status: Type.String(),
  note: Type.String(),
});

function createMockPool() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      if (/COUNT\(\*\)/.test(text)) return { rows: [{ total: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function createApp(dbTables) {
  const app = Fastify();
  const pool = createMockPool();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { dbTables });
  return { app, pool };
}

const search = (app, payload) => app.inject({ method: 'POST', url: '/search/order', payload });

describe('defineTable — one flat object', () => {
  it('schema filters by column equality, table-qualified', async () => {
    const { app, pool } = await createApp({ order: defineTable({ primary: 'id', schema: SchemaOrder }) });
    const res = await search(app, { filters: { status: 'paid' } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(pool.calls[0].text, /"customer_order"\."status" = \$1/);
    assert.deepEqual(pool.calls[0].values, ['paid']);
    await app.close();
  });

  for (const [label, extraFilters] of [
    ['a record of fields', { q: Type.String() }],
    ['a Type.Object', Type.Object({ q: Type.String() })],
  ]) {
    it(`extraFilters as ${label} reach extendedCondition, next to the column filters`, async () => {
      const order = defineTable({
        primary: 'id',
        schema: SchemaOrder,
        extraFilters,
        extendedCondition: (cb, filters) => {
          if (filters.q) cb.isILike('customer_order.note', `%${filters.q}%`);
        },
      });
      const { app, pool } = await createApp({ order });
      const res = await search(app, { filters: { q: 'urgent', status: 'paid' } });
      assert.equal(res.statusCode, 200, res.payload);
      assert.match(pool.calls[0].text, /"customer_order"\."status" = \$1/);
      assert.match(pool.calls[0].text, /customer_order\.note ILIKE \$2/);
      assert.deepEqual(pool.calls[0].values, ['paid', '%urgent%']);
      await app.close();
    });
  }

  it('an unknown filter is still a 400, extraFilters declared or not', async () => {
    const order = defineTable({ primary: 'id', schema: SchemaOrder, extraFilters: { q: Type.String() } });
    const { app } = await createApp({ order });
    const res = await search(app, { filters: { nope: 1 } });
    assert.equal(res.statusCode, 400, res.payload);
    await app.close();
  });

  it('the table config carries schema, not Schema', () => {
    const order = defineTable({ primary: 'id', schema: SchemaOrder });
    assert.equal(order.schema, SchemaOrder);
    assert.equal('Schema' in order, false);
    assert.equal('filters' in order, false);
  });
});

describe('the pre-1.0 config shape fails at startup, naming the new one', () => {
  it('exportTableInfo is no longer exported', () => {
    assert.equal(lib.exportTableInfo, undefined);
  });

  it('defineTable without schema throws', () => {
    assert.throws(() => defineTable({ primary: 'id' }), /schema/);
  });

  it('defineTable with Schema (the exportTableInfo spread) throws, pointing at schema', () => {
    assert.throws(
      () => defineTable({ primary: 'id', Schema: SchemaOrder, filters: () => {}, extraFilters: {} }),
      /'Schema'.*'schema'/s
    );
  });

  it('defineTable with a filters function throws, pointing at extendedCondition', () => {
    assert.throws(
      () => defineTable({ primary: 'id', schema: SchemaOrder, filters: () => {} }),
      /'filters'.*extendedCondition/s
    );
  });

  it('a dbTables entry in the old shape, not passed through defineTable, fails at register', async () => {
    const app = Fastify();
    app.decorate('pg', createMockPool());
    await assert.rejects(
      async () => {
        await app.register(fastifyAutoSqlApi, { dbTables: { order: { primary: 'id', Schema: SchemaOrder } } });
        await app.ready();
      },
      /dbTables\.order.*'schema'/s
    );
  });

  it('createSqlApi rejects the same old-shape entry', () => {
    assert.throws(
      () => createSqlApi(createMockPool(), { order: { primary: 'id', Schema: SchemaOrder } }, { dialect: 'postgres' }),
      /dbTables\.order.*'schema'/s
    );
  });

  it('the plugin option is dbTables: DbTables fails at register', async () => {
    const app = Fastify();
    app.decorate('pg', createMockPool());
    await assert.rejects(
      async () => {
        await app.register(fastifyAutoSqlApi, { DbTables: { order: defineTable({ primary: 'id', schema: SchemaOrder }) } });
        await app.ready();
      },
      /'DbTables'.*'dbTables'/s
    );
  });
});
