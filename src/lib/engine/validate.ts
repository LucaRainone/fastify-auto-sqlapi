import type { ApiRequest } from '../../types/request.js';
import type { QueryClient } from '../db.js';
import type {
  TableConfig,
  ValidationError,
  ValidationField,
  BulkValidatorItem,
  RowsByAlias,
} from '../../types.js';

function toResponseFields(errors: ValidationError[]): ValidationField[] {
  return errors.map(([path, code, message]) => ({
    path,
    code,
    message: message ?? code,
  }));
}

export async function runValidation(
  db: QueryClient,
  request: ApiRequest,
  tableConf: TableConfig,
  main: Record<string, unknown>,
  secondaries?: RowsByAlias
): Promise<void> {
  if (!tableConf.validate) return;

  const errors = await tableConf.validate(db, request, main, secondaries);
  if (errors.length > 0) {
    throwValidationError(toResponseFields(errors));
  }
}

export async function runBulkValidation(
  db: QueryClient,
  request: ApiRequest,
  tableConf: TableConfig,
  items: BulkValidatorItem[]
): Promise<void> {
  if (!tableConf.validateBulk) return;

  const errors = await tableConf.validateBulk(db, request, items);
  if (errors.length > 0) {
    throwValidationError(toResponseFields(errors));
  }
}

function throwValidationError(fields: ValidationField[]): never {
  const error = new Error('Validation failed') as Error & {
    statusCode: number;
    validationErrors: ValidationField[];
  };
  error.statusCode = 400;
  error.validationErrors = fields;
  throw error;
}
