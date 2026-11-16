import type { TSchema, Static } from 'typebox';
import type { RowsByAlias } from './db.js';
import type { HookContext } from './hooks.js';

/**
 * One entry of the `fields` array every 400 response carries, whether the error came from
 * the request schema, from a table's `validate`/`validateBulk`, or from the engine.
 *
 * - `path`: dot path of the offending value inside the request — body keys from the root
 *   (`main.name`, `secondaries.orders.0.total`, `filters.status`, `conditions.2.params`,
 *   `joinMultiple.orders.select.1`), querystring and path parameters by name (`orderBy`,
 *   `itemsPerPage`, `id`). The empty string when the error is not attributable to one input.
 * - `code`: machine-readable and stable — an Ajv keyword (`required`, `type`, `maximum`…),
 *   the code a `validate` hook returned, or one of the engine's codes (`unknown_field`,
 *   `not_readable`, `unknown_alias`, `invalid_params`…, see AGENTS_FRONTEND.md).
 * - `message`: Ajv's or the engine's description, for a developer; the code itself on an
 *   entry a hook returned — a hook writes no prose, the client translates the code.
 *
 * `validate` and `validateBulk` return these objects without `message`: `{ path, code }`.
 */
export interface ValidationField {
  path: string;
  code: string;
  message: string;
}

/** `validate`: the camelCase main record of an insert or update, and its secondaries by alias. */
export interface ValidateContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends HookContext {
  main: { [K in keyof F]?: Static<F[K]> };
  secondaries?: RowsByAlias;
}

/**
 * What a `validate`/`validateBulk` hook returns: one `{ path, code }` per problem, rendered as
 * a field of the 400 — `path` in the grammar of `ValidationField.path` (`main.name`,
 * `secondaries.orders.0.total`; in `validateBulk`, `items.3.main.code`), `code` the stable
 * code the client translates (`required`, `overlap`, `unique`). An empty array lets the write
 * through.
 */
type ValidatorResult = Pick<ValidationField, 'path' | 'code'>[];

export type ValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  ctx: ValidateContext<F>
) => Promise<ValidatorResult> | ValidatorResult;

export interface BulkValidatorItem<F extends Record<string, TSchema> = Record<string, TSchema>> {
  main: { [K in keyof F]?: Static<F[K]> };
  secondaries?: RowsByAlias;
}

/** `validateBulk`: every item of a bulk upsert, once. */
export interface BulkValidateContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends HookContext {
  items: BulkValidatorItem<F>[];
}

export type BulkValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  ctx: BulkValidateContext<F>
) => Promise<ValidatorResult> | ValidatorResult;
