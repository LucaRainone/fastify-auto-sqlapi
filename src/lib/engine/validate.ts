import type { ApiRequest } from '../../types/request.js';
import type { QueryClient } from '../db.js';
import type {
  TableConfig,
  ValidationField,
  BulkValidatorItem,
  RowsByAlias,
} from '../../types.js';

/**
 * The fields of the 400 for what a `validate`/`validateBulk` hook returned: `{ path, code }`
 * objects, `message` mirroring the code. Anything else is the hook's bug, not the client's —
 * a plain Error (500), never a 400 — and the pre-1.0 tuples are named, so they are not read
 * positionally into the wrong fields. A `message` is refused: the client translates the code.
 */
function toResponseFields(hook: string, errors: unknown): ValidationField[] {
  if (!Array.isArray(errors)) {
    throw new Error(`${hook} must return an array of { path, code } objects (empty: valid)`);
  }
  return errors.map((entry: unknown, i) => {
    const at = `${hook} returned [${i}]`;
    if (Array.isArray(entry)) {
      throw new Error(`${at} as a tuple, the pre-1.0 shape: return { path, code } objects`);
    }
    if (!entry || typeof entry !== 'object') throw new Error(`${at}: expected { path, code }`);
    const { path, code } = entry as Record<string, unknown>;
    if (Object.hasOwn(entry, 'message')) {
      throw new Error(`${at} with a 'message': return { path, code } only, the client translates the code`);
    }
    if (typeof path !== 'string') throw new Error(`${at}: path must be a string ('' when not attributable)`);
    if (typeof code !== 'string' || !code) throw new Error(`${at}: code must be a non-empty string`);
    return { path, code, message: code };
  });
}

export async function runValidation(
  db: QueryClient,
  request: ApiRequest | undefined,
  tableConf: TableConfig,
  main: Record<string, unknown>,
  secondaries?: RowsByAlias
): Promise<void> {
  if (!tableConf.validate) return;

  const fields = toResponseFields('validate', await tableConf.validate({ db, req: request, main, secondaries }));
  if (fields.length > 0) throwValidationError(fields);
}

export async function runBulkValidation(
  db: QueryClient,
  request: ApiRequest | undefined,
  tableConf: TableConfig,
  items: BulkValidatorItem[]
): Promise<void> {
  if (!tableConf.validateBulk) return;

  const fields = toResponseFields('validateBulk', await tableConf.validateBulk({ db, req: request, items }));
  if (fields.length > 0) throwValidationError(fields);
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
