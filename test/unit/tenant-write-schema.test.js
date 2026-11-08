// The engine fills the tenant column of a scoped table on insert (single-tenant caller), or
// validates the one the client sent (multi-tenant caller, `anyOf` anchor). The write body must
// therefore OFFER the column without REQUIRING it — exactly as the FK of a secondary is optional
// because the engine auto-fills it. A required tenant column would force every client to send
// a value the server already knows, and turn the documented injection into a 400.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Fastify from 'fastify';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
const { UpdateTableBody } = await import(path.join(ROOT, 'dist/lib/schema/update.js'));
const { BulkUpsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { fastifyAutoSqlApi, Type } = await import(path.join(ROOT, 'dist/index.js'));

// TypeBox marks an Optional property with a non-enumerable `~optional` key.
const isOptional = (schema) => schema['~optional'] === true;

const customerFields = { id: Type.Number(), name: Type.String(), organizationId: Type.Number() };
const orderFields = { id: Type.Number(), customerId: Type.Number(), total: Type.Number(), organizationId: Type.Number() };
const swapFields = { id: Type.Number(), requesterAgentId: Type.Number(), targetAgentId: Type.Number(), message: Type.String() };

/** `customer` (scope as given) writes `customer_order` (child scope as given) as a secondary. */
function createDbTables({ scope, childScope } = {}) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      insertExclude: ['id'],
      ...(scope ? { tenantScope: scope } : {}),
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
      insertExclude: ['id'],
      ...(childScope ? { tenantScope: childScope } : {}),
    },
  };
}

const DIRECT = { column: 'organization_id' };
const INDIRECT = (schema) => ({ column: 'organization_id', through: { schema, localField: 'customer_id', foreignField: 'id' } });

describe('insert body: the tenant column of a scoped table is offered, not required', () => {
  it('direct scope: the tenant field is Optional on main', () => {
    const body = InsertTableBody(createDbTables({ scope: DIRECT }), 'customer');
    const main = body.properties.main;
    assert.ok(isOptional(main.properties.organizationId), 'organizationId must be Optional');
    assert.ok(!isOptional(main.properties.name), 'other fields keep their requiredness');
  });

  it('direct scope: the column is still offered, so a multi-tenant caller can name it', () => {
    const body = InsertTableBody(createDbTables({ scope: DIRECT }), 'customer');
    assert.ok('organizationId' in body.properties.main.properties);
  });

  it('anyOf scope: every listed column is Optional (the runtime enforces the anchor rule)', () => {
    const swapSchema = createMockSchema('shift_swap_request', swapFields);
    const dbTables = {
      shift_swap_request: {
        primary: 'id',
        ...exportTableInfo(swapSchema),
        defaultOrder: 'id',
        insertExclude: ['id'],
        tenantScope: { anyOf: ['requester_agent_id', 'target_agent_id'] },
      },
    };
    const main = InsertTableBody(dbTables, 'shift_swap_request').properties.main;
    assert.ok(isOptional(main.properties.requesterAgentId));
    assert.ok(isOptional(main.properties.targetAgentId));
    assert.ok(!isOptional(main.properties.message));
  });

  it('indirect scope: the through-FK is an ordinary field and stays required', () => {
    const customerSchema = createMockSchema('customer', customerFields);
    const dbTables = createDbTables({ childScope: INDIRECT(customerSchema) });
    const main = InsertTableBody(dbTables, 'customer_order').properties.main;
    assert.ok(!isOptional(main.properties.customerId), 'nothing is injected for an indirect scope');
  });

  it('no scope: the column keeps its requiredness', () => {
    const main = InsertTableBody(createDbTables(), 'customer').properties.main;
    assert.ok(!isOptional(main.properties.organizationId));
  });
});

describe('secondaries items: the child tenant column is offered, not required', () => {
  const childItem = (body) => body.properties.secondaries.properties.customer_order.items;
  const bulkChildItem = (body) => body.items.properties.secondaries.properties.customer_order.items;

  it('insert body', () => {
    const item = childItem(InsertTableBody(createDbTables({ scope: DIRECT, childScope: DIRECT }), 'customer'));
    assert.ok(isOptional(item.properties.organizationId));
    assert.ok(!isOptional(item.properties.total));
  });

  it('update body', () => {
    const item = childItem(UpdateTableBody(createDbTables({ scope: DIRECT, childScope: DIRECT }), 'customer'));
    assert.ok(isOptional(item.properties.organizationId));
    assert.ok(!isOptional(item.properties.total));
  });

  it('bulk-upsert body', () => {
    const item = bulkChildItem(BulkUpsertTableBody(createDbTables({ scope: DIRECT, childScope: DIRECT }), 'customer'));
    assert.ok(isOptional(item.properties.organizationId));
    assert.ok(!isOptional(item.properties.total));
  });

  it('an unscoped child keeps the column required even under a scoped host', () => {
    const item = childItem(InsertTableBody(createDbTables({ scope: DIRECT }), 'customer'));
    assert.ok(!isOptional(item.properties.organizationId));
  });
});

describe('HTTP insert on a scoped table', () => {
  async function post(getTenantId, payload) {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], rowCount: 1 }, // main insert
      { rows: [{ id: 10 }], rowCount: 1 }, // secondary insert
    ]);
    const app = Fastify();
    app.decorate('pg', mockPg);
    await app.register(fastifyAutoSqlApi, { DbTables: createDbTables({ scope: DIRECT, childScope: DIRECT }), getTenantId });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/rest/customer', payload });
    await app.close();
    return { res, mockPg };
  }

  it('a single-tenant caller may omit the tenant column: the engine injects it', async () => {
    const { res, mockPg } = await post(() => 7, { main: { name: 'Mario' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.ok(mockPg.calls[0].text.includes('"organization_id"'), mockPg.calls[0].text);
    assert.ok(mockPg.calls[0].values.includes(7));
  });

  it('a secondary may omit it too, and gets the same injection', async () => {
    const { res, mockPg } = await post(() => 7, { main: { name: 'Mario' }, secondaries: { customer_order: [{ total: 5 }] } });
    assert.equal(res.statusCode, 201, res.body);
    assert.ok(mockPg.calls[1].values.includes(7), JSON.stringify(mockPg.calls[1]));
  });

  it('a foreign value sent explicitly is still refused with 403', async () => {
    const { res } = await post(() => 7, { main: { name: 'Mario', organizationId: 99 } });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('a multi-tenant caller omitting it gets the runtime 400, not a schema 400', async () => {
    const { res } = await post(() => [7, 8], { main: { name: 'Mario' } });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.body, /[Aa]mbiguous tenant/);
  });
});
