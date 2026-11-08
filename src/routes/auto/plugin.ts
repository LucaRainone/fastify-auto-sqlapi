import { STATUS_CODES } from 'node:http';
import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { ConditionBuilder } from 'node-condition-builder';
import { getDialect } from '../../lib/dialect.js';
import { ensureSqlApiDecorator } from '../sql-api-decorator.js';
import { setupSwagger } from '../setup-swagger.js';
import searchRoutes from './search.routes.js';
import getRoutes from './get.routes.js';
import insertRoutes from './insert.routes.js';
import updateRoutes from './update.routes.js';
import deleteRoutes from './delete.routes.js';
import bulkUpsertRoutes from './bulk-upsert.routes.js';
import bulkDeleteRoutes from './bulk-delete.routes.js';
import agentManifestRoutes from './agent-manifest.routes.js';
import type { SqlApiPluginOptions, ValidationField } from '../../types.js';

type AjvValidationErrors = NonNullable<FastifyError['validation']>;

/** What an error thrown inside a route may carry for the response, besides `statusCode`. */
interface CarriedErrorInfo {
  /** The `fields` of a 400: set by `httpError` (engine) and by `validate`/`validateBulk`. */
  validationErrors?: ValidationField[];
  /** Set under `exposeDebugInfo` on a sanitized 500 (ADR 0013). */
  debugInfo?: Record<string, unknown>;
}

// Schema combinators for which Ajv reports one error per failed branch plus a
// single combinator-level summary error, all targeting the same path.
const COMBINATOR_KEYWORDS = new Set(['anyOf', 'oneOf']);

/**
 * Converts Ajv validation errors into response fields, stripping the noise Ajv
 * emits for schema combinators.
 *
 * An enum modelled as `anyOf` of `const`s fails every branch when invalid, so Ajv
 * produces one `const` error per branch plus an `anyOf` error — all on the same
 * path. We keep only the combinator error for those paths and drop the per-branch
 * errors, then deduplicate any remaining identical entries. `required` errors are
 * re-pointed from the parent object to the actually missing property.
 */
function normalizeAjvErrors(errors: AjvValidationErrors): ValidationField[] {
  const toPath = (v: AjvValidationErrors[number]): string => {
    const path = (v.instancePath || '').replace(/\//g, '.').replace(/^\./, '');
    const missing = (v.params as { missingProperty?: string })?.missingProperty;
    if (v.keyword === 'required' && missing) {
      return path ? `${path}.${missing}` : missing;
    }
    return path;
  };

  const mapped: ValidationField[] = errors.map((v) => ({
    path: toPath(v),
    code: v.keyword || 'unknown',
    message: v.message || 'invalid',
  }));

  const combinatorPaths = new Set(
    mapped.filter((f) => COMBINATOR_KEYWORDS.has(f.code)).map((f) => f.path)
  );

  const seen = new Set<string>();
  return mapped.filter((f) => {
    if (combinatorPaths.has(f.path) && !COMBINATOR_KEYWORDS.has(f.code)) return false;
    const key = `${f.path}|${f.code}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default fp(async function fastifyAutoSqlApi(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  // Set ConditionBuilder dialect globally
  const dialect = getDialect(options.dialect || 'postgres');
  ConditionBuilder.DIALECT = dialect.cbDialect;

  // SqlApi: exposed to parent scope via fp
  ensureSqlApiDecorator(fastify, options);

  // Routes in a child scope — prefix applies here, not at fp level
  const { prefix, ...routeOptions } = options;
  await fastify.register(async (instance) => {
    // One envelope for every error, whoever raised it:
    //   { statusCode, error, message, requestId, fields? }
    // `error` is the status' reason phrase, never a JS error's class name. `requestId` is the
    // same value Fastify logs as `reqId`, so any error can be traced to its log line. Every
    // 400 carries `fields` — from the request schema (Ajv), from `validate`/`validateBulk`,
    // or from the engine through `httpError` — so a client has one place to look, and an
    // empty array when the rejection is not attributable to one input. `debugInfo` is
    // additive, under `exposeDebugInfo` only (ADR 0013).
    instance.setErrorHandler((error: FastifyError, request, reply) => {
      const carried = error as FastifyError & CarriedErrorInfo;
      const statusCode = error.validation ? 400 : (error.statusCode || 500);
      const fields = error.validation ? normalizeAjvErrors(error.validation) : carried.validationErrors;

      reply.status(statusCode).send({
        statusCode,
        error: STATUS_CODES[statusCode] ?? 'Error',
        message: error.validation ? 'Validation failed' : error.message,
        requestId: request.id,
        ...(statusCode === 400 ? { fields: fields ?? [] } : {}),
        ...(carried.debugInfo ? { debugInfo: carried.debugInfo } : {}),
      });
    });

    if (options.swagger) {
      await setupSwagger(instance, options);
    }

    await instance.register(searchRoutes, routeOptions);
    await instance.register(getRoutes, routeOptions);
    await instance.register(insertRoutes, routeOptions);
    await instance.register(updateRoutes, routeOptions);
    await instance.register(deleteRoutes, routeOptions);
    await instance.register(bulkUpsertRoutes, routeOptions);
    await instance.register(bulkDeleteRoutes, routeOptions);
    if (options.agentManifest) {
      await instance.register(agentManifestRoutes, routeOptions);
    }
  }, { prefix });
}, { name: 'fastify-auto-sqlapi' });
