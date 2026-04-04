import type { FastifyRequest } from 'fastify';
import type { QueryClient } from '../db.js';
import type { ITable, ValidationError, BulkValidatorItem } from '../../types.js';

export interface ValidationResponseField {
  path: string;
  code: string;
  message: string;
}

function toResponseFields(errors: ValidationError[]): ValidationResponseField[] {
  return errors.map(([path, code, message]) => ({
    path,
    code,
    message: message ?? code,
  }));
}

export async function runValidation(
  db: QueryClient,
  request: FastifyRequest,
  tableConf: ITable,
  main: Record<string, unknown>,
  secondaries?: Record<string, Record<string, unknown>[]>
): Promise<void> {
  if (!tableConf.validate) return;

  const errors = await tableConf.validate(db, request, main, secondaries);
  if (errors.length > 0) {
    throwValidationError(toResponseFields(errors));
  }
}

export async function runBulkValidation(
  db: QueryClient,
  request: FastifyRequest,
  tableConf: ITable,
  items: BulkValidatorItem[]
): Promise<void> {
  if (!tableConf.validateBulk) return;

  const errors = await tableConf.validateBulk(db, request, items);
  if (errors.length > 0) {
    throwValidationError(toResponseFields(errors));
  }
}

function throwValidationError(fields: ValidationResponseField[]): never {
  const error = new Error('Validation failed') as Error & {
    statusCode: number;
    validationErrors: ValidationResponseField[];
  };
  error.statusCode = 400;
  error.validationErrors = fields;
  throw error;
}
