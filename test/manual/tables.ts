import {
  Type,
  exportTableInfo,
  defineTable,
  buildRelation,
  buildUpsertRules,
  ConditionBuilder,
} from 'fastify-auto-sqlapi';
import type { DbTables, TenantScope } from 'fastify-auto-sqlapi';

import { SchemaCustomer } from './output/SchemaCustomer.js';
import { SchemaCustomerOrder } from './output/SchemaCustomerOrder.js';
import { SchemaProduct } from './output/SchemaProduct.js';

// ─── Table Configurations ────────────────────────────────────

const customerExtraFilters = {
  q: Type.String(),
};

const TableCustomer = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomer, customerExtraFilters, (condition, opts) => {
    if (opts.q) {
      const orCond = new ConditionBuilder('OR');
      orCond.isILike('name', `%${opts.q}%`);
      orCond.isILike('email', `%${opts.q}%`);
      orCond.isILike('phone_number', `%${opts.q}%`);
      condition.append(orCond);
    }
  }),
  defaultOrder: 'name',
  allowedReadJoins: [
    buildRelation(SchemaCustomer, 'id', SchemaCustomerOrder, 'customerId'),
  ],
  allowedWriteJoins: [
    buildRelation(SchemaCustomer, 'id', SchemaCustomerOrder, 'customerId'),
  ],
  excludeFromCreation: ['id'],
  tenantScope: { column: 'organization_id' },
});

const TableCustomerOrder = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaCustomerOrder),
  defaultOrder: 'order_date DESC',
  excludeFromCreation: ['id'],
  tenantScope: {
    column: 'organization_id',
    through: { schema: SchemaCustomer, localField: 'customer_id', foreignField: 'id' },
  },
});

const TableProduct = defineTable({
  primary: 'id',
  ...exportTableInfo(SchemaProduct),
  defaultOrder: 'name',
});

// ─── DbTables export ────────────────────────────────────────

export const dbTables: DbTables = {
  customer: TableCustomer,
  customer_order: TableCustomerOrder,
  product: TableProduct,
};
