// A response the schema cannot serialize is a server failure like any other (ADR 0013).
//
// It happens when the generated Schema is older than the database: a column turned from integer
// to text still has `Type.Integer()` in its Schema, and the serializer refuses a stored value.
// That error is raised after the route handler, by Fastify's serializer, so the route's own
// sanitization never sees it — and its message quotes the stored value. It must reach the
// client as the fixed 500, with the original in the log under the request's id.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

const STORED = 'IBAN IT60X0542811101000000123456';

// The Schema still says integer; the database returns the text the column now holds.
const SchemaProduct = createMockSchema('product', {
  id: Type.Optional(Type.Integer()),
  code: Type.Optional(Type.Integer()),
});

function createLogger(logged, bindings) {
  const logger = {
    level: 'error',
    fatal: () => {}, error: (obj) => logged.push(obj), warn: () => {},
    info: () => {}, debug: () => {}, trace: () => {}, silent: () => {},
    child(b) { bindings.push(b); return logger; },
  };
  return logger;
}

async function getProduct({ pluginOptions = {}, logged = [], bindings = [] } = {}) {
  const app = Fastify({ loggerInstance: createLogger(logged, bindings) });
  app.decorate('pg', { query: async () => ({ rows: [{ id: 1, code: STORED }], rowCount: 1 }) });
  await app.register(fastifyAutoSqlApi, {
    dbTables: { product: defineTable({ primary: 'id', schema: SchemaProduct }) },
    ...pluginOptions,
  });
  const res = await app.inject({ method: 'GET', url: '/rest/product/1' });
  await app.close();
  return res;
}

describe('a response the schema cannot serialize', () => {
  it('is the sanitized 500: the stored value does not reach the client', async () => {
    const res = await getProduct();
    assert.equal(res.statusCode, 500, res.payload);
    const body = res.json();
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(body.message, 'Internal Server Error');
    assert.equal(typeof body.requestId, 'string');
    assert.equal('fields' in body, false, res.payload);
    assert.equal('debugInfo' in body, false, res.payload);
    assert.ok(!res.payload.includes(STORED), `stored value leaked: ${res.payload}`);
  });

  it('is logged with its original message, under the reqId the response names', async () => {
    const logged = [];
    const bindings = [];
    const res = await getProduct({ logged, bindings });
    const entry = logged.find((e) => e?.err?.message?.includes(STORED));
    assert.ok(entry, `the serializer's error was never logged: ${JSON.stringify(logged)}`);
    assert.ok(bindings.some((b) => b.reqId === res.json().requestId), 'the log is not keyed on the response requestId');
  });

  it('carries debugInfo under exposeDebugInfo, like any other 500', async () => {
    const res = await getProduct({ pluginOptions: { exposeDebugInfo: true } });
    assert.equal(res.statusCode, 500, res.payload);
    assert.equal(res.json().message, 'Internal Server Error');
    assert.match(res.json().debugInfo.message, /cannot be converted to an integer/);
  });
});
