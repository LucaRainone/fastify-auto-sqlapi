// TableCustomer.ts (following Table{Table}.ts rules
import {
  exportTableInfo, buildRelation,
  buildUpsertRule, buildUpsertRules, ITable, ConditionBuilder, ConditionBuilderInterface
} from "fastify-sqlapi";
import "fastify-sqlapi";
import { Schema, SchemaCustomer, TypeSchema } from "../schemas/SchemaCustomer";
import {Static, Type} from "@sinclair/typebox";
import {SchemaInvoice} from "../schemas/SchemaInvoice";
// primary index for fetch single row in rest/{id}
const primary = "id";
// as is
type SchemaTable = TypeSchema;

// in case a database table has some fields that will be filled automatically from the database (like createdAt, updatedAt)
// or from the application (like createdBy, updatedBy)
const excludeFromCreation: Array<keyof (typeof Schema)["fields"]> = [
  "id",
  "createdAt",
  "updatedAt",
  "updatedBy"
];

// in case of need we can use extra command for filters. See exportTableInfo call below
const extraFiltersValidation = Type.Object({
  createdAtStart: Type.String(), // filter for createdAt >= input
  createdAtEnd: Type.String(), // filter for createdAt <= input
  updatedAtStart: Type.String(), // filter for updateAt >= input
  updatedAtEnd: Type.String(), // filter for updateAt <= input
  clientIds: Type.Array(Type.String()),
  q: Type.String()
});

// the filters object is the union of fields and extraFilters
type FilterByOpts = TypeSchema & Partial<Static<typeof extraFiltersValidation>>;

// rules for upsert for current table and related tables. The second argument is the unique key used
const upsertMap = buildUpsertRules(
  buildUpsertRule(Schema, ["id"]),
);

// allowed joins. You MUST define also the table allowed for upsert
const allowedReadJoins = [
  // join to table "invoice" on field customer_id. Select always all (*) fields
  buildRelation(Schema, "id", SchemaInvoice, "customerId", "*"),
];

// always export primary, and utilities in exportTableInfo, upsertMap, excludeFromCreation
// beforeInsert and beforeUpdate are optional, but mandatory in case we have updatedBy/createdBy
export default {
  primary,
  ...exportTableInfo<Array<keyof FilterByOpts>>(
    Schema,
    extraFiltersValidation.properties,
    (condition: ConditionBuilderInterface, opts: FilterByOpts) => {
      // here you can use the extraFilter with the power of ConditionBuilder
      // but basically with "opts.{extraFilter}" you can do whatever you want here
      condition
        .isBetween(Schema.col("createdAt"), opts.createdAtStart, opts.createdAtEnd)
        .isBetween(Schema.col("updatedAt"), opts.updatedAtStart, opts.updatedAtEnd)

      const condInOr = condition.newInstance("OR");
      const q = (opts.q && `%${opts.q}%`) || undefined;
      condInOr
        .isLike(Schema.col("name"), q)
        .isLike(Schema.col("taxNumber"), q)
        .isLike(Schema.col("legalName"), q)
        .isLike(Schema.col("fiscalCode"), q);

      condition.append(condInOr);
    }
  ),
  // index to check before the insert. If it exists, then update
  upsertMap,
  beforeInsert: async (db, request, record) => {

  },
  beforeUpdate(db, request, fields, secondaryFieldsFetcher) {
    const acl = request.acl;
    fields.updatedAt = new Date().toISOString();
    fields.updatedBy = acl?.user.id || 1;
  },
  allowedReadJoins,
  // restriction: { clientId: "client_id" }, // on jolly API, check if user can access to the client infos
  defaultOrder: "id",
  excludeFromCreation
} as ITable<SchemaTable>;
