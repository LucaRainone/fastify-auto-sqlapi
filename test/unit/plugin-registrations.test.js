import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  fastifyAutoSqlApi,
  searchRoutes,
  exportTableInfo,
  toUnderscore,
  Type,
} from '../../dist/index.js';

// One table set, several surfaces: the plugin (or a granular route plugin) registered more
// than once, each registration with its own dbTables, tenant resolver and table rules. Every
// registration's routes must run with the configuration they were registered with — never
// with whichever registration happened to decorate `sqlApi` first.

const fields = {
  id: Type.Number(),
  title: Type.String(),
  secret: Type.String(),
  organizationId: Type.Number(),
};
const SchemaConv = {
  col: (f) => toUnderscore(f),
  fields,
  validation: Type.Object(fields),
  tableName: 'conv',
  partialValidation: Type.Partial(Type.Object(fields)),
};

function conf(overrides = {}) {
  return { primary: 'id', ...exportTableInfo(SchemaConv), ...overrides };
}

// pg-shaped pool recording every statement
function createMockPool() {
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

async function buildApp(pool, register) {
  const app = Fastify();
  app.decorate('pg', pool);
  await register(app);
  await app.ready();
  return app;
}

describe('every plugin registration runs with its own configuration', () => {
  it('a second registration serves a table only its own dbTables declares', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool, async (app) => {
      await app.register(fastifyAutoSqlApi, { DbTables: { conv: conf() }, prefix: '/admin' });
      await app.register(fastifyAutoSqlApi, { DbTables: { onlyPublic: conf() }, prefix: '/public' });
    });

    const res = await app.inject({ method: 'POST', url: '/public/search/onlyPublic', payload: {} });
    assert.equal(res.statusCode, 200, res.body);

    await app.close();
  });

  it('a second registration applies its own readExclude to the statement', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool, async (app) => {
      await app.register(fastifyAutoSqlApi, { DbTables: { conv: conf() }, prefix: '/admin' });
      await app.register(fastifyAutoSqlApi, {
        DbTables: { conv: conf({ readExclude: ['secret'] }) },
        prefix: '/public',
      });
    });

    const res = await app.inject({ method: 'POST', url: '/public/search/conv', payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(pool.calls.length, 1);
    assert.doesNotMatch(pool.calls[0].text, /"secret"|"conv"\.\*/, 'the excluded column is projected');

    await app.close();
  });

  it('a second registration applies its own tenant scope and getTenantId', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool, async (app) => {
      await app.register(fastifyAutoSqlApi, { DbTables: { conv: conf() }, prefix: '/admin' });
      await app.register(fastifyAutoSqlApi, {
        DbTables: { conv: conf({ tenantScope: { column: 'organization_id' } }) },
        getTenantId: () => 42,
        prefix: '/tenant',
      });
    });

    const res = await app.inject({ method: 'POST', url: '/tenant/search/conv', payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(pool.calls.length, 1);
    assert.match(pool.calls[0].text, /"organization_id"/, 'the tenant filter is missing');
    assert.ok(pool.calls[0].values.includes(42), 'the tenant id is not bound');

    await app.close();
  });

  it('a granular route plugin next to the main plugin serves its own dbTables', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool, async (app) => {
      await app.register(fastifyAutoSqlApi, { DbTables: { conv: conf() } });
      await app.register(async (instance) => {
        await instance.register(searchRoutes, { DbTables: { onlyPublic: conf() } });
      }, { prefix: '/public' });
    });

    const res = await app.inject({ method: 'POST', url: '/public/search/onlyPublic', payload: {} });
    assert.equal(res.statusCode, 200, res.body);

    await app.close();
  });
});
