import type { TSchema, TObject } from '@sinclair/typebox';

export interface SchemaDefinition<T = Record<string, TSchema>> {
  col(field: string): string;
  colMap?: Record<string, string>;
  fields: T;
  validation: TObject;
  tableName: string;
  partialValidation: TObject;
  /** PRIMARY KEY fields (camelCase) as introspected from the DB. Set by generated schemas. */
  primaryKey?: string[];
  /**
   * Fields (camelCase) the database computes from an expression — `GENERATED ALWAYS AS (...)`.
   * Set by generated schemas. They are readable like any other column but every write path
   * drops them: the engine rejects a value for them, so offering the field could only ever
   * turn a client mistake into a driver error.
   */
  generatedFields?: string[];
  /**
   * The table's unique keys other than the primary key, each as its fields (camelCase), as
   * introspected from the DB. Set by generated schemas — always, even when empty, so an absent
   * property means "not known" rather than "none". `defineTable` verifies every `upsertMap`
   * rule against `primaryKey` and these (ADR 0021).
   */
  uniqueKeys?: string[][];
  /**
   * True when the underlying relation is a view. Set by generated schemas.
   *
   * A view is a table config like any other — this only records that the database had no
   * PRIMARY KEY to report, so an absent `primaryKey` means "not declared" rather than
   * "this data has no key".
   */
  isView?: boolean;
}
