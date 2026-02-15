import {
  Type,
  exportTableInfo,
  buildRelation,
  ConditionBuilder,
} from 'fastify-auto-sqlapi';
import type { ITable, DbTables } from 'fastify-auto-sqlapi';

import { SchemaCustomer } from './output/SchemaCustomer.js';
import { SchemaCustomerOrder } from './output/SchemaCustomerOrder.js';
import { SchemaProduct } from './output/SchemaProduct.js';

// ─── Table Configurations ────────────────────────────────────

const customerExtraFilters = {
  q: Type.String(),
};

const TableCustomer: ITable = {
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
};

const TableCustomerOrder: ITable = {
  primary: 'id',
  ...exportTableInfo(SchemaCustomerOrder),
  defaultOrder: 'order_date DESC',
};

const TableProduct: ITable = {
  primary: 'id',
  ...exportTableInfo(SchemaProduct),
  defaultOrder: 'name',
};

// ─── DbTables export ────────────────────────────────────────

export const dbTables: DbTables = {
  customer: TableCustomer,
  customer_order: TableCustomerOrder,
  product: TableProduct,
};
