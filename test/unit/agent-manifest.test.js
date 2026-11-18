// Agent manifest: machine-readable description of the exposed tables for LLM clients.
// buildAgentManifest derives everything from dbTables; the /agent/manifest routes are
// opt-in via the agentManifest plugin option and run behind global onRequests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const {
  fastifyAutoSqlApi, Type, Nullable, buildRelation,
  buildAgentManifest, renderAgentManifestMd, agentToolSchemas,
} = await import(path.join(ROOT, 'dist/index.js'));

function makeSchema(tableName, fields) {
  return {
    col: (f) => f,
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Partial(Type.Object(fields)),
  };
}

const customerSchema = makeSchema('customer', {
  id: Type.Number(),
  name: Type.String(),
  secret: Type.String(),
  createdAt: Type.Optional(Type.String()),
  parentId: Type.Optional(Nullable(Type.Number())),
});
const orderSchema = makeSchema('customer_order', {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
});
const userSchema = makeSchema('app_user', { id: Type.Number(), name: Type.String() });

function makeDbTables() {
  return {
    customer: {
      primary: 'id',
      schema: customerSchema,
      extraFilters: { q: Type.String() },
      insertExclude: ['id'],
      readExclude: ['secret'],
      writeExclude: ['createdAt'],
      defaultOrder: 'name',
      computedFields: {
        upperName: ({ qiCol }) => ({ expr: `UPPER(${qiCol('name')})`, type: Type.String() }),
      },
      readJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' }),
        buildRelation(customerSchema, 'parentId', userSchema, 'id', { alias: 'creator', unique: true }),
      ],
      writeJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' }),
      ],
    },
    link: {
      primary: ['agentId', 'teamId'],
      schema: makeSchema('agent_team', { agentId: Type.Number(), teamId: Type.Number() }),
      operations: ['search', 'insert', 'update', 'bulkUpsert'],
    },
    readonly: {
      primary: 'id',
      schema: userSchema,
      operations: ['search', 'get'],
    },
  };
}

describe('buildAgentManifest', () => {
  const m = buildAgentManifest(makeDbTables());

  it('describes fields with type / required / nullable / writeOnly', () => {
    const f = m.tables.customer.fields;
    assert.deepEqual(f.id, { type: 'number', required: true });
    assert.deepEqual(f.parentId, { type: 'number', nullable: true });
    assert.deepEqual(f.secret, { type: 'string', required: true, writeOnly: true });
    assert.deepEqual(f.createdAt, { type: 'string', readOnly: true });
  });

  it('reports operations honoring the whitelist and composite-PK rules', () => {
    assert.deepEqual(m.tables.readonly.operations, ['search', 'get']);
    // composite PK: get/delete/bulkDelete are never exposed
    assert.deepEqual(m.tables.link.operations, ['search', 'insert', 'update', 'bulkUpsert']);
    assert.equal(m.tables.customer.operations.length, 7);
  });

  it('reports join aliases with direction, computed fields and extraFilters', () => {
    const t = m.tables.customer;
    assert.deepEqual(t.readJoins, [
      { alias: 'orders', table: 'customer_order', kind: '1:N' },
      { alias: 'creator', table: 'app_user', kind: 'N:1' },
    ]);
    assert.deepEqual(t.writeJoins, [{ alias: 'orders', table: 'customer_order', kind: '1:N' }]);
    assert.deepEqual(t.computed, { upperName: 'string' });
    assert.deepEqual(t.extraFilters, { q: 'string' });
    assert.deepEqual(t.serverGenerated, ['id']);
  });
});

describe('renderAgentManifestMd', () => {
  it('renders one compact block per table', () => {
    const md = renderAgentManifestMd(buildAgentManifest(makeDbTables()));
    assert.match(md, /## customer {2}PK:id {2}ops:search,get,insert,update,delete,bulkUpsert,bulkDelete/);
    assert.match(md, /parentId:number\?/);
    assert.match(md, /secret:string!\(writeOnly\)/);
    assert.match(md, /createdAt:string\(readOnly\)/);
    assert.match(md, /readJoins: orders→customer_order\(1:N\), creator→app_user\(N:1\)/);
    assert.match(md, /## agent_team {2}PK:agentId\+teamId/);
  });

  // A field the API returns but refuses on every write has to say so in the notation the
  // model actually reads: without it an agent keeps sending the column back and keeps
  // getting it dropped.
  it('explains the readOnly notation in the legend', () => {
    const md = renderAgentManifestMd(buildAgentManifest(makeDbTables()));
    assert.match(md, /`\(readOnly\)`=returned by reads, refused by every write/);
  });
});

// A table's own upsert key decides what a write must carry: every row its key (else 400
// missing_key), and a serverGenerated key only for a row that exists (else 400 not_found).
// Without it in the manifest an agent learns the rule only from the 400s.
describe('the manifest reports a table\'s upsert key', () => {
  const withUpsertKey = () => {
    const dbTables = makeDbTables();
    dbTables.customer.upsertKey = ['id'];
    return dbTables;
  };

  it('as upsertKey on the table, absent when the table has none', () => {
    const m = buildAgentManifest(withUpsertKey());
    assert.deepEqual(m.tables.customer.upsertKey, ['id']);
    assert.equal('upsertKey' in m.tables.readonly, false);
  });

  it('as an upsertKey line in the markdown, with its rule in the legend', () => {
    const md = renderAgentManifestMd(buildAgentManifest(withUpsertKey()));
    assert.match(md, /## customer [^\n]*\n[^#]*upsertKey: id\n/);
    assert.match(md, /upsertKey: insert and bulkUpsert update the row with that key/);
    assert.doesNotMatch(md.split('## app_user')[1] ?? '', /upsertKey:/);
  });
});

describe('agentManifest routes', () => {
  it('not registered by default', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, { dbTables: makeDbTables() });
    await app.ready();
    assert.equal(app.hasRoute({ method: 'GET', url: '/agent/manifest' }), false);
    await app.close();
  });

  it('serves JSON and markdown when enabled (under the prefix)', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      dbTables: makeDbTables(),
      agentManifest: true,
      prefix: '/api',
    });
    await app.ready();

    const json = await app.inject({ method: 'GET', url: '/api/agent/manifest' });
    assert.equal(json.statusCode, 200);
    assert.ok(JSON.parse(json.payload).tables.customer);

    const md = await app.inject({ method: 'GET', url: '/api/agent/manifest.md' });
    assert.equal(md.statusCode, 200);
    assert.match(md.headers['content-type'], /text\/markdown/);
    assert.match(md.payload, /## customer/);
    await app.close();
  });

  it('runs behind global onRequests', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      dbTables: makeDbTables(),
      agentManifest: true,
      onRequests: [async (_req, reply) => reply.status(401).send({ error: 'auth' })],
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/agent/manifest' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

describe('agentToolSchemas', () => {
  it('returns JSON schemas only for enabled operations', () => {
    const schemas = agentToolSchemas(makeDbTables(), 'readonly');
    assert.ok(schemas.search, 'search must be present');
    assert.equal(schemas.insert, undefined);
    assert.equal(schemas.update, undefined);
    assert.equal(schemas.bulkUpsert, undefined);
    assert.equal(schemas.bulkDelete, undefined);
  });

  it('search schema carries the whole request in the body; bulk respects maxBulkItems', () => {
    const schemas = agentToolSchemas(makeDbTables(), 'customer', { maxItemsPerPage: 100, maxBulkItems: 5 });
    assert.ok(schemas.search.body.properties.filters);
    assert.equal(schemas.search.body.properties.paginator.properties.itemsPerPage.maximum, 100);
    assert.equal(schemas.bulkUpsert.body.maxItems, 5);
  });

  it('composite-PK table gets no bulkDelete schema', () => {
    const schemas = agentToolSchemas(makeDbTables(), 'link');
    assert.equal(schemas.bulkDelete, undefined);
    assert.ok(schemas.insert);
  });

  it('throws on unknown table', () => {
    assert.throws(() => agentToolSchemas(makeDbTables(), 'nope'), /Unknown table/);
  });
});
