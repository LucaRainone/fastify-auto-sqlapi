// A route the plugin did not register answers Fastify's own 404 (AGENTS_FRONTEND.md, "Errors"):
// the plugin's error envelope covers the routes it mounts, not the ones it left out — an
// operation narrowed away, or get/delete on a composite-PK table. Pinned so the docs can say it;
// a plugin-wide not-found handler would change both together.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

const SchemaLink = createMockSchema('link', { aId: Type.Integer(), bId: Type.Integer() });

describe('a route the plugin did not register', () => {
  it('get on a composite-PK table is Fastify\'s 404, without the envelope\'s requestId', async () => {
    const app = Fastify();
    app.decorate('pg', { query: async () => ({ rows: [] }) });
    await app.register(fastifyAutoSqlApi, {
      dbTables: { link: defineTable({ primary: ['aId', 'bId'], schema: SchemaLink }) },
    });
    const res = await app.inject({ method: 'GET', url: '/rest/link/1' });
    assert.equal(res.statusCode, 404, res.payload);
    assert.equal(res.json().error, 'Not Found');
    assert.equal('requestId' in res.json(), false, res.payload);
    await app.close();
  });
});
