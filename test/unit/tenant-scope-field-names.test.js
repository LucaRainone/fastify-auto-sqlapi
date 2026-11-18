// `tenantScope` names schema fields, like every other key of a table config: each name is
// resolved to its column through the schema it belongs to — `column`, `anyOf` and
// `through.localField` through the table's own schema, the `column` and `through.foreignField`
// of an indirect scope through `through.schema`. The column of a field is accepted as written,
// so a scope naming the real columns keeps working. Checked on a snake_case database,
// where a field and its column differ.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Fastify from 'fastify';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, buildRelation, Type } = await import(path.join(ROOT, 'dist/index.js'));

const TENANT_ID = 7;

const customerSchema = createMockSchema('customer', {
  id: Type.Optional(Type.Number()),
  name: Type.String(),
  organizationId: Type.Number(),
});
const orderSchema = createMockSchema('customer_order', {
  id: Type.Optional(Type.Number()),
  customerId: Type.Number(),
  total: Type.Number(),
});
const swapSchema = createMockSchema('shift_swap_request', {
  id: Type.Optional(Type.Number()),
  requesterAgentId: Type.Optional(Type.Number()),
  targetAgentId: Type.Optional(Type.Number()),
  message: Type.String(),
});

const DIRECT = { column: 'organizationId' };
const INDIRECT = { column: 'organizationId', through: { schema: customerSchema, localField: 'customerId', foreignField: 'id' } };
const ANY_OF = { anyOf: ['requesterAgentId', 'targetAgentId'] };

const dbTables = {
  customer: defineTable({
    primary: 'id',
    schema: customerSchema,
    defaultOrder: 'id',
    insertExclude: ['id'],
    tenantScope: DIRECT,
    readJoins: [buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' })],
  }),
  customer_order: defineTable({ primary: 'id', schema: orderSchema, defaultOrder: 'id', tenantScope: INDIRECT }),
  shift_swap_request: defineTable({ primary: 'id', schema: swapSchema, defaultOrder: 'id', insertExclude: ['id'], tenantScope: ANY_OF }),
};

/** The statements a request runs, against an app whose caller belongs to TENANT_ID. */
async function statementsOf(request, responses) {
  const mockPg = createMockPg(responses);
  const app = Fastify();
  app.decorate('pg', mockPg);
  await app.register(fastifyAutoSqlApi, { dbTables, getTenantId: () => TENANT_ID });
  const res = await app.inject(request);
  await app.close();
  assert.ok(res.statusCode < 300, `answered ${res.statusCode}: ${res.body}`);
  return mockPg.calls;
}

const sqlOf = (calls) => calls.map((c) => c.text).join('\n');

describe('tenantScope names schema fields, resolved to their columns', () => {
  it('a direct scope filters reads on the column of its field', async () => {
    const calls = await statementsOf(
      { method: 'POST', url: '/search/customer', payload: {} },
      [{ rows: [], rowCount: 0 }]
    );
    assert.match(sqlOf(calls), /"customer"\."organization_id" IN/);
    assert.doesNotMatch(sqlOf(calls), /organizationId/);
  });

  it('a direct scope fills the column of its field on insert, the field offered and not required', async () => {
    const calls = await statementsOf(
      { method: 'POST', url: '/rest/customer', payload: { main: { name: 'Mario' } } },
      [{ rows: [{ id: 1 }], rowCount: 1 }]
    );
    const insert = calls.find((c) => /^INSERT/i.test(c.text));
    assert.match(insert.text, /"organization_id"/);
    assert.ok(insert.values.includes(TENANT_ID), 'the tenant id is written');
  });

  it('an indirect scope joins on the columns of localField and foreignField, and filters the parent column', async () => {
    const calls = await statementsOf(
      { method: 'POST', url: '/search/customer_order', payload: {} },
      [{ rows: [], rowCount: 0 }]
    );
    const sql = sqlOf(calls);
    assert.match(sql, /INNER JOIN "customer" ON "customer_order"\."customer_id" = "customer"\."id"/);
    assert.match(sql, /"customer"\."organization_id" IN/);
    assert.doesNotMatch(sql, /organizationId|customerId/);
  });

  it('an anyOf scope tests the column of every listed field', async () => {
    const calls = await statementsOf(
      { method: 'POST', url: '/search/shift_swap_request', payload: {} },
      [{ rows: [], rowCount: 0 }]
    );
    const sql = sqlOf(calls);
    assert.match(sql, /"requester_agent_id" IN/);
    assert.match(sql, /"target_agent_id" IN/);
    assert.doesNotMatch(sql, /requesterAgentId|targetAgentId/);
  });

  it('an anyOf scope reads its anchor from the column of a listed field on insert', async () => {
    const calls = await statementsOf(
      { method: 'POST', url: '/rest/shift_swap_request', payload: { main: { requesterAgentId: TENANT_ID, message: 'swap?' } } },
      [{ rows: [{ id: 1 }], rowCount: 1 }]
    );
    const insert = calls.find((c) => /^INSERT/i.test(c.text));
    assert.match(insert.text, /"requester_agent_id"/);
  });

  it('a joined table is scoped on the column of its field in the side query', async () => {
    const viaCustomer = await statementsOf(
      { method: 'POST', url: '/search/customer', payload: { joinMultiple: { orders: {} } } },
      [{ rows: [{ id: 1, name: 'Mario', organization_id: TENANT_ID }], rowCount: 1 }, { rows: [], rowCount: 0 }]
    );
    const side = viaCustomer[1].text;
    assert.match(side, /INNER JOIN "customer" ON "customer_order"\."customer_id" = "customer"\."id"/);
    assert.match(side, /"organization_id" IN/);
  });

  it('the column of a field is taken as written: a scope naming the real columns keeps working', async () => {
    const legacy = {
      ...dbTables,
      customer: defineTable({ primary: 'id', schema: customerSchema, defaultOrder: 'id', tenantScope: { column: 'organization_id' } }),
    };
    const mockPg = createMockPg([{ rows: [], rowCount: 0 }]);
    const app = Fastify();
    app.decorate('pg', mockPg);
    await app.register(fastifyAutoSqlApi, { dbTables: legacy, getTenantId: () => TENANT_ID });
    await app.inject({ method: 'POST', url: '/search/customer', payload: {} });
    await app.close();
    assert.match(mockPg.calls[0].text, /"customer"\."organization_id" IN/);
  });

  it('an anyOf scope naming one column twice, once by its field, is refused', () => {
    assert.throws(
      () => defineTable({ primary: 'id', schema: swapSchema, tenantScope: { anyOf: ['requesterAgentId', 'requester_agent_id'] } }),
      /tenantScope 'anyOf' on table 'shift_swap_request' repeats a column/
    );
  });
});
