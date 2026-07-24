// Composite-PK tables cannot be addressed by a single PK value: get/delete/bulkDelete
// would match on the first PK column alone and (for deletes) remove every row sharing
// that value. The routes are skipped at registration (or fail loudly when explicitly
// requested via `operations`), and the engines guard programmatic sqlApi.* calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { fastifyAutoSqlApi, Type } = await import(path.join(ROOT, 'dist/index.js'));
const { getEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/get.js'));
const { deleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/delete.js'));
const { bulkDeleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-delete.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));

function createCompositeTable(operations) {
  const fields = { agentId: Type.Number(), teamId: Type.Number(), role: Type.String() };
  return {
    primary: ['agentId', 'teamId'],
    Schema: {
      col: (f) => f,
      fields,
      validation: Type.Object(fields),
      tableName: 'agent_team',
      partialValidation: Type.Partial(Type.Object(fields)),
    },
    filters: () => ({ build: () => ({ where: '1=1', values: [] }) }),
    extraFilters: {},
    ...(operations ? { operations } : {}),
  };
}

const ROUTES = {
  search: { method: 'POST', url: '/search/agent_team' },
  get: { method: 'GET', url: '/rest/agent_team/:id' },
  insert: { method: 'POST', url: '/rest/agent_team' },
  update: { method: 'PUT', url: '/rest/agent_team' },
  delete: { method: 'DELETE', url: '/rest/agent_team/:id' },
  bulkUpsert: { method: 'PUT', url: '/bulk/agent_team' },
  bulkDelete: { method: 'POST', url: '/bulk/agent_team/delete' },
};

describe('composite PK - route registration', () => {
  it('skips get/delete/bulkDelete by default, keeps the other operations', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      DbTables: { agent_team: createCompositeTable(undefined) },
    });
    await app.ready();

    assert.equal(app.hasRoute(ROUTES.get), false, 'get must NOT be registered');
    assert.equal(app.hasRoute(ROUTES.delete), false, 'delete must NOT be registered');
    assert.equal(app.hasRoute(ROUTES.bulkDelete), false, 'bulkDelete must NOT be registered');

    assert.equal(app.hasRoute(ROUTES.search), true, 'search must be registered');
    assert.equal(app.hasRoute(ROUTES.insert), true, 'insert must be registered');
    assert.equal(app.hasRoute(ROUTES.update), true, 'update must be registered');
    assert.equal(app.hasRoute(ROUTES.bulkUpsert), true, 'bulkUpsert must be registered');

    await app.close();
  });

  it('throws at startup when operations explicitly requests a single-PK route', async () => {
    const app = Fastify();
    await assert.rejects(
      async () => {
        await app.register(fastifyAutoSqlApi, {
          DbTables: { agent_team: createCompositeTable(['search', 'delete']) },
        });
        await app.ready();
      },
      /composite primary key.*"delete"/s
    );
    await app.close();
  });
});

describe('composite PK - engine guards (programmatic sqlApi.*)', () => {
  const makeDb = () => new QueryClient(createMockPg([]));

  it('getEngine rejects with 400', async () => {
    await assert.rejects(
      () => getEngine({ db: makeDb(), tableConf: createCompositeTable(), id: 1 }),
      (err) => err.statusCode === 400 && /composite primary key/.test(err.message)
    );
  });

  it('deleteEngine rejects with 400 before touching the DB', async () => {
    const mockPg = createMockPg([]);
    await assert.rejects(
      () => deleteEngine({ db: new QueryClient(mockPg), tableConf: createCompositeTable(), id: 1 }),
      (err) => err.statusCode === 400 && /composite primary key/.test(err.message)
    );
    assert.equal(mockPg.calls.length, 0, 'no SQL must be issued');
  });

  it('bulkDeleteEngine rejects with 400 before touching the DB', async () => {
    const mockPg = createMockPg([]);
    await assert.rejects(
      () => bulkDeleteEngine({ db: new QueryClient(mockPg), tableConf: createCompositeTable(), ids: [1, 2] }),
      (err) => err.statusCode === 400 && /composite primary key/.test(err.message)
    );
    assert.equal(mockPg.calls.length, 0, 'no SQL must be issued');
  });
});
