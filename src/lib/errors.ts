import type { ValidationField } from '../types.js';

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
 * same shape as a schema or `validate` error. Errors with another status carry no fields.
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

/**
 * Replace an error escaping a route handler with one that carries no database detail.
 *
 * Driver messages name tables, columns and constraints, and the route error handler sends
 * `error.message` verbatim — so a unique violation describes the schema to whoever
 * triggered it. Errors the plugin raises itself are deliberate `4xx` with messages written
 * for clients (`httpError`, `validationErrors`) and pass through untouched; everything
 * else becomes a bare `500`.
 *
 * The original is attached as `cause`, so a consumer `setErrorHandler` can still apply its
 * own policy — mapping SQLSTATE to a status code stays the consumer's decision (ADR 0006).
 * No status code is remapped here: a `500` stays a `500`.
 *
 * `requestId` is carried on the sanitized error and rendered in the response body: it is the
 * same value Fastify logs as `reqId` on every line, so the log entry holding the real error
 * is one grep away from the client's `500`.
 *
 * With `exposeDebugInfo`, the original is also described in a `debugInfo` payload rendered
 * beside those fields — additive, so the response a client codes against is the same one it
 * gets in production. It is off by default and derived from nothing: `debug` belongs to the
 * consumer, who may wire it to an environment variable, and no option may open an external
 * channel as a side effect of meaning something internal. See ADR 0013.
 */
export function sanitizeRouteError(
  err: unknown,
  requestId?: string,
  exposeDebugInfo = false,
): unknown {
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return err;

  const safe = httpError(500, 'Internal Server Error') as Error & {
    statusCode: number;
    requestId?: string;
    debugInfo?: Record<string, unknown>;
  };
  safe.cause = err;
  if (requestId) safe.requestId = requestId;
  if (exposeDebugInfo) safe.debugInfo = describeError(err);
  return safe;
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
