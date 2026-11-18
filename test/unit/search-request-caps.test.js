// The caps on a search request, as an HTTP client meets them (AGENTS_FRONTEND.md, "Errors").
//
// The request schema checks the size of `conditions` and the length of `orderBy` before the
// engine runs, so those answer with the Ajv keyword; only the number of `orderBy` parts is the
// engine's, `limit_exceeded`. A paginator, even empty, asks for the `pagination` block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));
const { MAX_CONDITIONS, MAX_ORDER_BY_PARTS, MAX_ORDER_BY_LENGTH } = await import(
  path.join(ROOT, 'dist/lib/condition-methods.js')
);
const { DEFAULT_ITEMS_PER_PAGE } = await import(path.join(ROOT, 'dist/types/plugin.js'));

const SchemaItem = createMockSchema('item', {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
});

async function createApp() {
  const app = Fastify();
  // The COUNT of a paginated search answers `total`; the main select, no rows.
  app.decorate('pg', { query: async (q) => (/COUNT\(\*\)/.test(q.text ?? q) ? { rows: [{ total: '0' }] } : { rows: [] }) });
  await app.register(fastifyAutoSqlApi, { dbTables: { item: defineTable({ primary: 'id', schema: SchemaItem }) } });
  return app;
}

async function search(payload) {
  const app = await createApp();
  const res = await app.inject({ method: 'POST', url: '/search/item', payload });
  await app.close();
  return res;
}

const fieldsOf = (res) => res.json().fields.map((f) => [f.path, f.code]);

describe('search caps over HTTP', () => {
  it(`more than ${MAX_CONDITIONS} conditions is a 400 maxItems at conditions`, async () => {
    const conditions = Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ field: 'id', method: 'isEqual', params: [1] }));
    const res = await search({ conditions });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['conditions', 'maxItems']]);
  });

  it(`an orderBy longer than ${MAX_ORDER_BY_LENGTH} characters is a 400 maxLength at orderBy`, async () => {
    const res = await search({ orderBy: 'name,'.repeat(205) + 'id' });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['orderBy', 'maxLength']]);
  });

  it(`more than ${MAX_ORDER_BY_PARTS} orderBy parts is a 400 limit_exceeded at orderBy`, async () => {
    const res = await search({ orderBy: Array.from({ length: MAX_ORDER_BY_PARTS + 1 }, () => 'id').join(',') });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['orderBy', 'limit_exceeded']]);
  });

  it(`an empty paginator returns the pagination block, page 1 of ${DEFAULT_ITEMS_PER_PAGE}`, async () => {
    const res = await search({ paginator: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().pagination.paginator, { page: 1, itemsPerPage: DEFAULT_ITEMS_PER_PAGE });
  });
});
