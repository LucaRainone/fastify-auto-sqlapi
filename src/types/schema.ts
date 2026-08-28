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
}
