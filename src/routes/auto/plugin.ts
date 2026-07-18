import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { ConditionBuilder } from 'node-condition-builder';
import { getDialect } from '../../lib/dialect.js';
import { ensureSqlApiDecorator } from '../../lib/sql-api-decorator.js';
import { setupSwagger } from '../../lib/setup-swagger.js';
import searchRoutes from './search.routes.js';
import getRoutes from './get.routes.js';
import insertRoutes from './insert.routes.js';
import updateRoutes from './update.routes.js';
import deleteRoutes from './delete.routes.js';
import bulkUpsertRoutes from './bulk-upsert.routes.js';
import bulkDeleteRoutes from './bulk-delete.routes.js';
import type { SqlApiPluginOptions } from '../../types.js';

type AjvValidationErrors = NonNullable<FastifyError['validation']>;

interface ValidationResponseField {
  path: string;
  message: string;
  code: string;
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
function normalizeAjvErrors(errors: AjvValidationErrors): ValidationResponseField[] {
  const toPath = (v: AjvValidationErrors[number]): string => {
    const path = (v.instancePath || '').replace(/\//g, '.').replace(/^\./, '');
    const missing = (v.params as { missingProperty?: string })?.missingProperty;
    if (v.keyword === 'required' && missing) {
      return path ? `${path}.${missing}` : missing;
    }
    return path;
  };

  const mapped = errors.map((v) => ({
    path: toPath(v),
    message: v.message || 'invalid',
    code: v.keyword || 'unknown',
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
    // Structured validation errors with field-level detail
    instance.setErrorHandler((error: FastifyError, request, reply) => {
      // Schema validation errors (Ajv)
      if (error.validation) {
        const fields = normalizeAjvErrors(error.validation);
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          fields,
        });
      }

      // Custom validation errors (validate / validateBulk)
      const validationErrors = (error as any).validationErrors;
      if (validationErrors) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          fields: validationErrors,
        });
      }

      const statusCode = error.statusCode || 500;
      reply.status(statusCode).send({
        statusCode,
        error: error.name || 'Error',
        message: error.message,
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
  }, { prefix });
}, { name: 'fastify-auto-sqlapi' });
