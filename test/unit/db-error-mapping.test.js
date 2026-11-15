import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fastifyAutoSqlApi, searchRoutes, toUnderscore, Type } from '../../dist/index.js';

// `dbErrors`: the consumer maps the driver error codes it cares about to an HTTP status and a
// code of its own, which the client translates. The mapping is partial by nature — codes
// depend on the database and its version — so the plugin interprets nothing: an unmapped error
// stays the sanitized 500 of ADR 0013, and a mapped one is answered in the plugin's envelope,
// with no driver detail and no prose of the consumer's.

const CONSTRAINT_MESSAGE = 'duplicate key value violates unique constraint "users_email_key"';

const schema = {
  col: (f) => toUnderscore(f),
  fields: { id: Type.Number(), name: Type.String() },
  validation: Type.Object({ id: Type.Number(), name: Type.String() }),
  tableName: 'test_table',
  partialValidation: Type.Partial(Type.Object({ id: Type.Number(), name: Type.String() })),
};

const dbTables = { test_table: { primary: 'id', schema } };

/** pg-shaped pool whose every query rejects with the given driver code. */
function createFailingPool(code = '23505') {
  return {
    query() {
      const err = new Error(CONSTRAINT_MESSAGE);
      err.code = code;
      err.constraint = 'users_email_key';
      return Promise.reject(err);
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

const search = (app) => app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

function assertNoDriverDetail(res) {
  for (const leak of ['users_email_key', 'duplicate key', 'constraint']) {
    assert.ok(!res.body.includes(leak), `"${leak}" leaked to the client: ${res.body}`);
  }
}

describe('dbErrors maps driver error codes to an HTTP status and a code', () => {
  it('a mapped driver code answers its status and the consumer code, without driver detail', async () => {
    const app = await buildApp(createFailingPool('23505'), (app) =>
      app.register(fastifyAutoSqlApi, { dbTables, dbErrors: { '23505': { status: 409, code: 'duplicate' } } })
    );

    const res = await search(app);
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json();
    assert.equal(body.statusCode, 409);
    assert.equal(body.error, 'Conflict');
    assert.equal(body.message, 'Conflict');
    assert.equal(typeof body.requestId, 'string');
    assert.deepEqual(body.fields, [{ path: '', code: 'duplicate', message: 'Conflict' }]);
    assertNoDriverDetail(res);
    await app.close();
  });

  it('a driver code mapped to 400 carries the consumer code in fields', async () => {
    const app = await buildApp(createFailingPool('23514'), (app) =>
      app.register(fastifyAutoSqlApi, { dbTables, dbErrors: { '23514': { status: 400, code: 'check_failed' } } })
    );

    const res = await search(app);
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields, [{ path: '', code: 'check_failed', message: 'Bad Request' }]);
    await app.close();
  });

  it('an unmapped driver code stays the sanitized 500, without fields', async () => {
    const app = await buildApp(createFailingPool('23503'), (app) =>
      app.register(fastifyAutoSqlApi, { dbTables, dbErrors: { '23505': { status: 409, code: 'duplicate' } } })
    );

    const res = await search(app);
    assert.equal(res.statusCode, 500, res.body);
    assert.equal(res.json().message, 'Internal Server Error');
    assert.equal(res.json().fields, undefined);
    assertNoDriverDetail(res);
    await app.close();
  });

  it('exposeDebugInfo stays additive on a mapped driver code', async () => {
    const app = await buildApp(createFailingPool('23505'), (app) =>
      app.register(fastifyAutoSqlApi, {
        dbTables,
        dbErrors: { '23505': { status: 409, code: 'duplicate' } },
        exposeDebugInfo: true,
      })
    );

    const res = await search(app);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().message, 'Conflict');
    assert.equal(res.json().debugInfo.code, '23505');
    await app.close();
  });

  it('a route plugin registered standalone hands the mapped error to the consumer handler', async () => {
    let seen = null;
    const app = await buildApp(createFailingPool('23505'), (app) => {
      app.setErrorHandler((err, request, reply) => {
        seen = err;
        reply.status(err.statusCode).send({ message: err.message });
      });
      return app.register(searchRoutes, { dbTables, dbErrors: { '23505': { status: 409, code: 'duplicate' } } });
    });

    const res = await search(app);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(seen.statusCode, 409);
    assert.deepEqual(seen.validationErrors.map((f) => f.code), ['duplicate']);
    assert.equal(seen.cause.code, '23505', 'the original error is not reachable as cause');
    await app.close();
  });

  for (const [label, dbErrors] of [
    ['a bare status without a code', { '23505': 409 }],
    ['a status outside 400–599', { '23505': { status: 200, code: 'duplicate' } }],
    ['a non-integer status', { '23505': { status: 409.5, code: 'duplicate' } }],
    ['a status that is not a number', { '23505': { status: '409', code: 'duplicate' } }],
    ['a missing code', { '23505': { status: 409 } }],
    ['an empty code', { '23505': { status: 409, code: '' } }],
  ]) {
    it(`registration fails on ${label}`, async () => {
      const app = Fastify();
      app.decorate('pg', createFailingPool());
      app.register(fastifyAutoSqlApi, { dbTables, dbErrors });
      await assert.rejects(app.ready(), /dbErrors\["23505"\]/);
    });
  }
});
