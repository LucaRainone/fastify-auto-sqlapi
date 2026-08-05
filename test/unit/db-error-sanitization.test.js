import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fastifyAutoSqlApi, searchRoutes, exportTableInfo, toUnderscore, Type } from '../../dist/index.js';

// A driver error carries schema details — table, column and constraint names — in its
// message. ADR 0013: those never reach the client, while the consumer keeps the original
// error through the log and `err.cause`.

const CONSTRAINT_MESSAGE =
  'duplicate key value violates unique constraint "users_email_key"';

const schema = {
  col: (f) => toUnderscore(f),
  fields: { id: Type.Number(), name: Type.String() },
  validation: Type.Object({ id: Type.Number(), name: Type.String() }),
  tableName: 'test_table',
  partialValidation: Type.Partial(Type.Object({ id: Type.Number(), name: Type.String() })),
};

const DbTables = {
  test_table: {
    primary: 'id',
    ...exportTableInfo(schema),
  },
};

/** pg-shaped pool whose every query rejects like a constraint violation would. */
function createFailingPool() {
  return {
    query() {
      const err = new Error(CONSTRAINT_MESSAGE);
      err.code = '23505';
      err.constraint = 'users_email_key';
      return Promise.reject(err);
    },
  };
}

/** pg-shaped pool returning canned responses in order. */
function createMockPool(responses = []) {
  let callIndex = 0;
  return {
    query() {
      const response = responses[callIndex] || { rows: [], rowCount: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

/**
 * Minimal pino-shaped logger. `logged` collects what `error()` received; `bindings` collects
 * what each `child()` was created with, which is where Fastify puts `reqId`.
 */
function createFakeLogger(logged = [], bindings = []) {
  const logger = {
    level: 'error',
    fatal: () => {}, error: (obj) => logged.push(obj), warn: () => {},
    info: () => {}, debug: () => {}, trace: () => {}, silent: () => {},
    child(b) { bindings.push(b); return logger; },
  };
  return logger;
}

async function buildApp(pool, register, fastifyOptions = {}) {
  const app = Fastify(fastifyOptions);
  app.decorate('pg', pool);
  await register(app);
  await app.ready();
  return app;
}

function assertNoLeak(res) {
  assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
  assert.ok(
    !res.body.includes('users_email_key'),
    `constraint name leaked to the client: ${res.body}`
  );
  assert.ok(
    !res.body.includes('duplicate key'),
    `driver message leaked to the client: ${res.body}`
  );
  assert.equal(res.json().message, 'Internal Server Error');
  assert.equal(res.json().debugInfo, undefined, 'debug info must be opt-in');
}

describe('database errors are sanitized before reaching the client', () => {
  it('a driver error surfaces as a bare 500 (main plugin)', async () => {
    const app = await buildApp(createFailingPool(), (app) =>
      app.register(fastifyAutoSqlApi, { DbTables })
    );

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    assertNoLeak(res);
    await app.close();
  });

  it('a driver error surfaces as a bare 500 (route plugin registered standalone)', async () => {
    const app = await buildApp(createFailingPool(), (app) =>
      app.register(searchRoutes, { DbTables })
    );

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    assertNoLeak(res);
    await app.close();
  });

  it('4xx raised by the plugin keeps its message', async () => {
    const app = await buildApp(createMockPool(), (app) =>
      app.register(fastifyAutoSqlApi, { DbTables })
    );

    const res = await app.inject({ method: 'GET', url: '/rest/test_table/7' });

    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().message, 'Record not found: 7');
    await app.close();
  });

  it('the original error stays reachable through err.cause', async () => {
    let seen = null;
    const app = await buildApp(createFailingPool(), (app) => {
      app.setErrorHandler((err, request, reply) => {
        seen = err;
        reply.status(500).send({ statusCode: 500, message: err.message });
      });
      return app.register(searchRoutes, { DbTables });
    });

    await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    assert.ok(seen, 'the consumer error handler never ran');
    assert.equal(seen.message, 'Internal Server Error');
    assert.ok(seen.cause, 'the original error was not attached as cause');
    assert.equal(seen.cause.message, CONSTRAINT_MESSAGE);
    assert.equal(seen.cause.code, '23505');
    assert.ok(seen.requestId, 'the sanitized error carries no request id to correlate on');
    await app.close();
  });

  it('the full driver error is logged server-side', async () => {
    const logged = [];
    const logger = createFakeLogger(logged);
    const app = await buildApp(
      createFailingPool(),
      (app) => app.register(fastifyAutoSqlApi, { DbTables }),
      { loggerInstance: logger }
    );

    await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    const withError = logged.filter((entry) => entry && entry.err);
    assert.ok(withError.length > 0, 'the driver error was never logged');
    assert.ok(
      withError.some((entry) => entry.err.message === CONSTRAINT_MESSAGE),
      `the logged error lost the driver message: ${JSON.stringify(logged)}`
    );
    await app.close();
  });

  it('the request id in the body is the reqId the log is keyed on', async () => {
    // The guarantee is correlation: whatever the client is handed must be greppable in the
    // server log. Fastify binds `reqId` on the request logger — assert against that value,
    // not against a literal, so the test still holds if the id format changes.
    const bindings = [];
    const logger = createFakeLogger([], bindings);
    const app = await buildApp(
      createFailingPool(),
      (app) => app.register(fastifyAutoSqlApi, { DbTables }),
      { loggerInstance: logger }
    );

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    const reqId = bindings.find((b) => b && b.reqId)?.reqId;
    assert.ok(reqId, 'Fastify never bound a reqId on the request logger');
    assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().requestId, reqId);
    await app.close();
  });

  it('exposeDebugInfo attaches the driver error without changing the contract', async () => {
    const app = await buildApp(createFailingPool(), (app) =>
      app.register(fastifyAutoSqlApi, { DbTables, exposeDebugInfo: true })
    );

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });
    const body = res.json();

    // The fields a client codes against are the same ones it gets in production...
    assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(body.message, 'Internal Server Error');
    assert.ok(body.requestId, 'requestId disappeared under exposeDebugInfo');
    // ...and the driver detail arrives beside them, structured.
    assert.equal(body.debugInfo.message, CONSTRAINT_MESSAGE);
    assert.equal(body.debugInfo.code, '23505');
    assert.equal(body.debugInfo.constraint, 'users_email_key');
    assert.ok(body.debugInfo.stack, 'the stack is the other half of what a developer needs');
    await app.close();
  });

  it('exposeDebugInfo does not touch the 4xx the plugin raises itself', async () => {
    const app = await buildApp(createMockPool(), (app) =>
      app.register(fastifyAutoSqlApi, { DbTables, exposeDebugInfo: true })
    );

    const res = await app.inject({ method: 'GET', url: '/rest/test_table/7' });
    const body = res.json();

    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);
    assert.equal(body.message, 'Record not found: 7');
    assert.equal(body.debugInfo, undefined, 'a deliberate 4xx needs no debug payload');
    await app.close();
  });

  it('debug does not change what the client sees — it is an observability switch', async () => {
    // Whoever registers the plugin decides `debug`, so the library cannot assume how it is
    // wired: constant in a config file for some, an env var flipped during an incident for
    // others. Only `exposeDebugInfo` opens the wire. ADR 0013.
    const app = await buildApp(createFailingPool(), (app) =>
      app.register(fastifyAutoSqlApi, { DbTables, debug: true })
    );

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    assertNoLeak(res);
    await app.close();
  });

  it('NODE_ENV is never consulted: the default stays sanitized in development', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const app = await buildApp(createFailingPool(), (app) =>
        app.register(fastifyAutoSqlApi, { DbTables })
      );

      const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

      assertNoLeak(res);
      await app.close();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('errors thrown by consumer onRequests hooks pass through untouched', async () => {
    const app = await buildApp(createMockPool(), (app) =>
      app.register(fastifyAutoSqlApi, {
        DbTables,
        onRequests: [async () => { throw new Error('hook exploded'); }],
      })
    );

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });

    assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().message, 'hook exploded');
    await app.close();
  });
});
