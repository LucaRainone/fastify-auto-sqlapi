import { STATUS_CODES } from 'node:http';
import type { ValidationField, DbErrorMapping } from '../types.js';

/** What a 400 the engine raises says about the input it rejects, see `ValidationField`. */
export interface HttpErrorField {
  /** Stable machine-readable code (`unknown_field`, `invalid_params`, …). */
  code: string;
  /** Dot path of the offending value in the request; omitted or '' when not attributable. */
  path?: string;
}

/**
 * Build a plain Error decorated with `statusCode`, which the plugin's error handler reads to
 * emit the corresponding HTTP response.
 *
 * A 400 should also say what was wrong with the input: `field` is rendered as the single
 * entry of the response's `fields` array, so an engine rejection reaches the client in the
 * same shape as a schema or `validate` error. Another status takes a `field` only where the
 * client must read a code, as a `dbErrors` answer does (ADR 0024).
 *
 * Using a function instead of a custom class keeps the throw sites lightweight
 * and matches the existing convention across the codebase.
 */
export function httpError(
  statusCode: number,
  message: string,
  field?: HttpErrorField,
): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number; validationErrors?: ValidationField[] };
  err.statusCode = statusCode;
  if (field) err.validationErrors = [{ path: field.path ?? '', code: field.code, message }];
  return err;
}

/** How a route answers an error it did not raise itself: the plugin options that decide it. */
export interface RouteErrorPolicy {
  /** The request's id, rendered as `requestId` so the client can name the log line. */
  requestId?: string;
  /** Attach the driver error as an additive `debugInfo` payload (ADR 0013). */
  exposeDebugInfo?: boolean;
  /** Driver error codes the consumer answers with a status instead of `500`. */
  dbErrors?: Record<string, DbErrorMapping>;
}

/**
 * Replace an error escaping a route handler with one that carries no database detail.
 *
 * Driver messages name tables, columns and constraints, and the route error handler sends
 * `error.message` verbatim — so a unique violation describes the schema to whoever
 * triggered it. Errors the plugin raises itself are deliberate `4xx` with messages written
 * for clients (`httpError`, `validationErrors`) and pass through untouched; a driver error
 * whose `code` the consumer listed in `dbErrors` gets that status and the consumer's code, as
 * the single entry of `fields`; everything else becomes a bare `500`. The plugin maps no code of
 * its own: which ones deserve a status depends on the database, its version and the product
 * (ADR 0006).
 *
 * The original is attached as `cause`, and logged by the route under the same `reqId`.
 *
 * `requestId` is carried on the sanitized error and rendered in the response body: it is the
 * same value Fastify logs as `reqId` on every line, so the log entry holding the real error
 * is one grep away from the client's response.
 *
 * With `exposeDebugInfo`, the original is also described in a `debugInfo` payload rendered
 * beside those fields — additive, so the response a client codes against is the same one it
 * gets in production. It is off by default and derived from nothing: `debug` belongs to the
 * consumer, who may wire it to an environment variable, and no option may open an external
 * channel as a side effect of meaning something internal. See ADR 0013.
 */
export function sanitizeRouteError(err: unknown, policy: RouteErrorPolicy = {}): unknown {
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return err;

  const mapped = mapDbError(err, policy.dbErrors);
  const safe = (mapped
    ? httpError(mapped.status, STATUS_CODES[mapped.status] ?? 'Error', { code: mapped.code })
    : httpError(500, 'Internal Server Error')) as Error & {
    statusCode: number;
    requestId?: string;
    debugInfo?: Record<string, unknown>;
  };
  safe.cause = err;
  if (policy.requestId) safe.requestId = policy.requestId;
  if (policy.exposeDebugInfo) safe.debugInfo = describeError(err);
  return safe;
}

/** The consumer's `dbErrors` entry for this error's driver code; undefined when none. */
function mapDbError(
  err: unknown,
  dbErrors: Record<string, DbErrorMapping> | undefined,
): DbErrorMapping | undefined {
  const driverCode = (err as { code?: unknown } | null | undefined)?.code;
  if (!dbErrors || typeof driverCode !== 'string' || !Object.hasOwn(dbErrors, driverCode)) return undefined;
  return dbErrors[driverCode];
}

/**
 * Refuse a `dbErrors` option a route could not honour, at registration rather than on the
 * first failing request: every entry is `{ status, code }`, the status an integer in 400–599,
 * the code a non-empty string.
 */
export function assertDbErrors(dbErrors: unknown): void {
  if (dbErrors === undefined) return;
  if (dbErrors === null || typeof dbErrors !== 'object' || Array.isArray(dbErrors)) {
    throw new Error('dbErrors must be an object keyed by driver error code');
  }
  for (const [driverCode, entry] of Object.entries(dbErrors)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`dbErrors["${driverCode}"]: expected { status, code }, got ${JSON.stringify(entry)}`);
    }
    const { status, code } = entry as { status?: unknown; code?: unknown };
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
      throw new Error(`dbErrors["${driverCode}"]: the status must be an integer between 400 and 599, got ${JSON.stringify(status)}`);
    }
    if (typeof code !== 'string' || code === '') {
      throw new Error(`dbErrors["${driverCode}"]: the code must be a non-empty string, got ${JSON.stringify(code)}`);
    }
  }
}

/**
 * Driver properties worth handing a developer, across both supported drivers: `pg` puts the
 * schema detail in `constraint`/`detail`/`table`/`column`, `mysql2` in `errno`/`sqlState`/
 * `sqlMessage`. Copied by allowlist rather than spread, so a driver that starts attaching
 * the connection config (password included) to its errors cannot ship it to a client.
 */
const DEBUG_ERROR_PROPS = [
  'code', 'errno', 'sqlState', 'sqlMessage',
  'constraint', 'detail', 'hint', 'table', 'column', 'schema', 'routine', 'position',
] as const;

function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };

  const info: Record<string, unknown> = { name: err.name, message: err.message };
  for (const prop of DEBUG_ERROR_PROPS) {
    const value = (err as unknown as Record<string, unknown>)[prop];
    if (value !== undefined) info[prop] = value;
  }
  if (err.stack) info.stack = err.stack;
  return info;
}
