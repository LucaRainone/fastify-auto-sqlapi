import { DbPowered } from "./dbPowered";
import { toCamelCase, toUnderscore } from "../../db/util/Mapping";
import { SecondaryTables, TableRecord } from "../../routes/types";
import { ConditionBuilder } from "@conditionbuilder/ConditionBuilder";
import { dbDelete } from "./delete";
import {SchemaDefinition} from "../../interfaces";
import {ManagedError} from "../../errors";

interface IRecord {
  record: {
    [key: string]: any;
  };
}

interface IRecords {
  record: {
    [key: string]: any;
  }[];
}

export async function insert(db: DbPowered, table: string, values: Record<string, any>): Promise<IRecord> {
  values = Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      return [toUnderscore(k), v];
    })
  );

  const row = await db.insert(table, values);

  return {
    record: Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        return [toCamelCase(k), v];
      })
    )
  };
}

export async function insertJoins<T = TableRecord>(
  db: DbPowered,
  table: string,
  values: T,
  secondaries: SecondaryTables
) {
  const res = await insert(db, table, values);
  const row = res.record;
  const secondaryRecords = {};
  for (const secondaryTable in secondaries) {
    const secondaryRows = secondaries[secondaryTable];
    const field = `${table}_id`;
    for (let i = 0; i < secondaryRows.length; i++) {
      const secondaryRow = secondaryRows[i];
      const srow = await insert(db, secondaryTable, { ...secondaryRow, [field]: row.id });
      if (!secondaryRecords[secondaryTable]) {
        secondaryRecords[secondaryTable] = [];
      }
      secondaryRecords[secondaryTable].push(srow.record);
    }
  }

  return {
    record: row,
    secondaryRecords
  };
}

export async function update(
  db: DbPowered,
  table: string,
  values: Record<string, any>,
  where: Record<string, any>,
  extraCondition?: ConditionBuilder
): Promise<IRecords> {
  values = Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      return [toUnderscore(k), v];
    })
  );
  where = Object.fromEntries(
    Object.entries(where).map(([k, v]) => {
      return [toUnderscore(k), v];
    })
  );

  const rows = await db.update(table, values, where, extraCondition);

  return {
    record: rows
  };
}
export async function upsert(
  db: DbPowered,
  table: string,
  values: Record<string, any>,
  primary: string[]
): Promise<IRecord> {
  values = Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      return [toUnderscore(k), v];
    })
  );
  primary = primary.map((p) => toUnderscore(p));

  const rows = await db.insertOrUpdate(table, values, primary);
  return {
    record: rows
  };
}

export async function upsertJoin(
  db: DbPowered,
  table: string,
  values: TableRecord,
  secondaries: SecondaryTables,
  deletions: SecondaryTables,
  upsertMap: Map<SchemaDefinition, string[]>,
  extraCondition: ConditionBuilder
) {
  const mainUnique = {};
  const primaries = {};
  Array.from(upsertMap.entries() || []).map(([schema, fields]) => {
    // fields.map(field=> {
    //   mainUnique[toUnderscore(field)] = values[toCamelCase(field)];
    // });
    primaries[schema.tableName] = fields;
  });

  primaries[table].forEach((field) => {
    mainUnique[toUnderscore(field)] = values[toCamelCase(field)];
    delete values[field];
  });

  let rows = [];
  if (Object.keys(values).length > 0) {
    const res = await update(db, table, values, mainUnique, extraCondition);
    rows = res.record.map((record) => Object.fromEntries(Object.entries(record).map(([k, v]) => [toCamelCase(k), v])));
  }
  const secondaryRecordss = [];
  const secondaryRecords = {};

  for (const secondaryTable in secondaries) {
    if (secondaryTable === table) {
      throw new ManagedError("You cannot update main table on secondaries fields", "BAD_USE", 400);
    }
    const secondaryRows = secondaries[secondaryTable];
    for (let i = 0; i < secondaryRows.length; i++) {
      const secondaryRow = secondaryRows[i];
      secondaryRow[`${table}_id`] = values.id;
      const srow = await upsert(db, secondaryTable, { ...secondaryRow }, primaries[secondaryTable]);
      if (!secondaryRecords[secondaryTable]) {
        secondaryRecords[secondaryTable] = [];
      }
      secondaryRecords[secondaryTable].push(
        Object.fromEntries(Object.entries(srow.record).map(([k, v]) => [toCamelCase(k), v]))
      );
    }
  }
  const deleted = [];
  for (const tableRowDelete in deletions) {
    if (tableRowDelete === table) {
      throw new ManagedError(
        "You cannot delete main table rows on `secondaries` fields. Use DELETE methods or bulk/table/*/delete",
        "BAD_USE",
        400
      );
    }
    const secondaryRowsToDelete = deletions[tableRowDelete];
    for (let i = 0; i < secondaryRowsToDelete.length; i++) {
      const secondaryRow = secondaryRowsToDelete[i];
      // TODO
      secondaryRow[`${table}_id`] = values.id;
      const count = await dbDelete(db, tableRowDelete, secondaryRow);
      if (count > 0) {
        deleted.push(secondaryRow);
      }
    }
  }

  secondaryRecordss.push(secondaryRecords);

  return {
    body: {
      record: rows,
      secondaryRecords: secondaryRecords,
      deleted
    }
  };
}
