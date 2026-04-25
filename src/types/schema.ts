import type { TSchema, TObject } from '@sinclair/typebox';

export interface SchemaDefinition<T = Record<string, TSchema>> {
  col(field: string): string;
  colMap?: Record<string, string>;
  fields: T;
  validation: TObject;
  tableName: string;
  partialValidation: TObject;
}
