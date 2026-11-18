// A `tenantScope` name the schema does not know is refused at startup (ADR 0032).
//
// Each name must be a field of the schema it belongs to, or the column of one: `column`,
// `anyOf` and `through.localField` against the table's own schema, the `column` and
// `through.foreignField` of an indirect scope against `through.schema`. Anything else is a
// misspelling, and taken as a column it would only fail as a 500 on the first request.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockSchema, ROOT } from './_harness.js';

const { defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

const customerSchema = createMockSchema('customer', {
  id: Type.Optional(Type.Number()),
  organizationId: Type.Number(),
});
const orderSchema = createMockSchema('customer_order', {
  id: Type.Optional(Type.Number()),
  customerId: Type.Number(),
});
const swapSchema = createMockSchema('shift_swap_request', {
  id: Type.Optional(Type.Number()),
  requesterAgentId: Type.Optional(Type.Number()),
  targetAgentId: Type.Optional(Type.Number()),
});

const through = (over = {}) => ({ schema: customerSchema, localField: 'customerId', foreignField: 'id', ...over });
const direct = (column) => defineTable({ primary: 'id', schema: customerSchema, tenantScope: { column } });
const anyOf = (names) => defineTable({ primary: 'id', schema: swapSchema, tenantScope: { anyOf: names } });
const indirect = (column, over) => defineTable({ primary: 'id', schema: orderSchema, tenantScope: { column, through: through(over) } });

/** The startup error names the scope key, the table, the name, and the fields to pick from. */
const refuses = (key, table, name, field) => (err) =>
  err instanceof Error &&
  err.message.includes(`tenantScope '${key}' on table '${table}'`) &&
  err.message.includes(`'${name}'`) &&
  err.message.includes(field);

describe('a tenantScope name the schema does not know is refused at startup', () => {
  it('a direct column that is neither a field nor the column of one', () => {
    assert.throws(() => direct('organizationid'), refuses('column', 'customer', 'organizationid', 'organizationId'));
  });

  it('an anyOf entry that is neither a field nor the column of one', () => {
    assert.throws(() => anyOf(['requesterAgentId', 'targetAgentID']), refuses('anyOf', 'shift_swap_request', 'targetAgentID', 'targetAgentId'));
  });

  it('a through.localField the table\'s own schema does not know', () => {
    assert.throws(() => indirect('organizationId', { localField: 'customer' }), refuses('through.localField', 'customer_order', 'customer', 'customerId'));
  });

  it('an indirect column the parent schema does not know, even when the table\'s own would', () => {
    assert.throws(() => indirect('customerId'), refuses('column', 'customer', 'customerId', 'organizationId'));
  });

  it('a through.foreignField the parent schema does not know', () => {
    assert.throws(() => indirect('organizationId', { foreignField: 'customerId' }), refuses('through.foreignField', 'customer', 'customerId', 'id'));
  });
});

describe('a tenantScope name the schema knows is accepted', () => {
  it('by its field', () => {
    assert.doesNotThrow(() => direct('organizationId'));
    assert.doesNotThrow(() => anyOf(['requesterAgentId', 'targetAgentId']));
    assert.doesNotThrow(() => indirect('organizationId'));
  });

  it('by the column of a field, as a 0.6 scope names it', () => {
    assert.doesNotThrow(() => direct('organization_id'));
    assert.doesNotThrow(() => anyOf(['requester_agent_id', 'target_agent_id']));
    assert.doesNotThrow(() => indirect('organization_id', { localField: 'customer_id' }));
  });
});
