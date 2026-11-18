// `extendedCondition` names its columns with `col(field)`, its third argument: the column quoted
// for the dialect and qualified the way the statement it lands in needs — the table name in the
// main search and in a side query, the alias inside a correlated subquery.
//
// Without it the consumer had no form that worked everywhere: a bare `Schema.col()` is unquoted
// (Postgres folds `orderDate` to `orderdate`), and a table-name prefix inside an aliased subquery
// either fails or, on a self-relation, silently binds to the outer row.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const { createSqlApi, defineTable, buildRelation, Type } = await import(path.join(ROOT, 'dist/index.js'));

/** A camelCase database: every column is spelled like its field. */
const camel = (table, fields) => ({ ...createMockSchema(table, fields), col: (f) => f });

const Order = camel('order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Integer(),
  orderDate: Type.Optional(Type.String()),
});
const Customer = camel('customer', { id: Type.Optional(Type.Integer()), name: Type.String() });
const Person = camel('person', {
  id: Type.Optional(Type.Integer()),
  parentId: Type.Optional(Type.Integer()),
  orderDate: Type.Optional(Type.String()),
});

const since = (c, f, { col }) => { c.isGreaterOrEqual(col('orderDate'), f.from); };

const tables = () => ({
  customer: defineTable({
    primary: 'id', schema: Customer,
    readJoins: [buildRelation(Customer, 'id', Order, 'customerId', { alias: 'orders' })],
  }),
  order: defineTable({ primary: 'id', schema: Order, extraFilters: { from: Type.String() }, extendedCondition: since }),
  person: defineTable({
    primary: 'id', schema: Person, extraFilters: { from: Type.String() }, extendedCondition: since,
    readJoins: [buildRelation(Person, 'id', Person, 'parentId', { alias: 'children' })],
  }),
});

async function statements(dialect, table, params) {
  const pool = createMockPg(() => ({ rows: [] }), { checkQualification: false });
  await createSqlApi(pool, tables(), { dialect }).search(table, params);
  return pool.calls.map((c) => c.text.replace(/\s+/g, ' '));
}

const FROM = { from: '2026-01-01' };

describe('extendedCondition: col(field) is quoted and qualified for where the condition runs', () => {
  it('the main search: the table, quoted for Postgres', async () => {
    const [main] = await statements('postgres', 'order', { filters: FROM });
    assert.match(main, /WHERE \("order"\."orderDate" >= \$1\)/, main);
  });

  it('the main search: the table, quoted for MySQL', async () => {
    const [main] = await statements('mysql', 'order', { filters: FROM });
    assert.match(main, /WHERE \(`order`\.`orderDate` >= \?\)/, main);
  });

  it('a joinMustExist subquery: the alias of its FROM', async () => {
    const [main] = await statements('postgres', 'customer', { joinMustExist: { orders: { filters: FROM } } });
    assert.match(main, /FROM "order" AS "orders" WHERE .*"orders"\."orderDate" >= \$1/, main);
  });

  it('a self-relation: the inner alias, never the outer row', async () => {
    const [main] = await statements('postgres', 'person', { joinMustExist: { children: { filters: FROM } } });
    assert.match(main, /FROM "person" AS "children" WHERE .*"children"\."orderDate" >= \$1/, main);
    assert.doesNotMatch(main, /"person"\."orderDate"/, main);
  });

  it('a joinMultiple side query: the table it reads', async () => {
    const pool = createMockPg((q) => ({ rows: /FROM "customer"/.test(q.text) ? [{ id: 1, name: 'a' }] : [] }), { checkQualification: false });
    await createSqlApi(pool, tables()).search('customer', { joinMultiple: { orders: { filters: FROM } } });
    const side = pool.calls.map((c) => c.text.replace(/\s+/g, ' ')).find((t) => /FROM "order"/.test(t));
    assert.match(side, /"order"\."orderDate" >= \$\d/, side);
  });

  it('a name that is not a field of the schema is a programming error naming it', async () => {
    const t = tables();
    t.order = defineTable({
      primary: 'id', schema: Order, extraFilters: { from: Type.String() },
      extendedCondition: (c, f, { col }) => { c.isEqual(col('from'), f.from); },
    });
    const pool = createMockPg(() => ({ rows: [] }));
    await assert.rejects(
      () => createSqlApi(pool, t).search('order', { filters: FROM }),
      (err) => !err.statusCode && /extendedCondition of table 'order'.*col\('from'\)/.test(err.message),
    );
  });

  it('the second argument keeps its meaning: an extendedCondition without col still runs', async () => {
    const t = tables();
    t.order = defineTable({
      primary: 'id', schema: Order, extraFilters: { from: Type.String() },
      extendedCondition: (c, f) => { c.isGreaterOrEqual('"order"."orderDate"', f.from); },
    });
    const pool = createMockPg(() => ({ rows: [] }));
    await createSqlApi(pool, t).search('order', { filters: FROM });
    assert.match(pool.calls[0].text, /"order"\."orderDate" >= \$1/);
  });
});
