import type { TSchema, Static } from 'typebox';
import type { ApiRequest } from './request.js';
import type { QueryClient } from '../lib/db.js';
import type { RowsByAlias } from './join.js';

/**
 * One entry of the `fields` array every 400 response carries, whether the error came from
 * the request schema, from a table's `validate`/`validateBulk`, or from the engine.
 *
 * - `path`: dot path of the offending value inside the request — body keys from the root
 *   (`main.name`, `secondaries.orders.0.total`, `filters.status`, `conditions.2.params`,
 *   `joinMultiple.orders.selection`), querystring and path parameters by name (`orderBy`,
 *   `itemsPerPage`, `id`). The empty string when the error is not attributable to one input.
 * - `code`: machine-readable and stable — an Ajv keyword (`required`, `type`, `maximum`…),
 *   the code a `validate` hook returned, or one of the engine's codes (`unknown_field`,
 *   `not_readable`, `unknown_alias`, `invalid_params`…, see AGENTS_FRONTEND.md).
 * - `message`: human-readable description.
 */
export interface ValidationField {
  path: string;
  code: string;
  message: string;
}

/**
 * Validation error tuple a `validate`/`validateBulk` hook returns: [field, code] or
 * [field, code, message]. Rendered verbatim as a `ValidationField`.
 * - field: the request path of the invalid value, in the grammar of `ValidationField.path`
 *   (e.g. 'main.name', 'secondaries.orders.0.total'; in `validateBulk`, 'items.3.main.code')
 * - code: machine-readable error code (e.g. 'required', 'overlap', 'unique')
 * - message: human-readable description (defaults to code if omitted)
 */
export type ValidationError =
  | [field: string, code: string]
  | [field: string, code: string, message: string];

export type ValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  db: QueryClient,
  req: ApiRequest,
  main: { [K in keyof F]?: Static<F[K]> },
  secondaries?: RowsByAlias
) => Promise<ValidationError[]> | ValidationError[];

export interface BulkValidatorItem<F extends Record<string, TSchema> = Record<string, TSchema>> {
  main: { [K in keyof F]?: Static<F[K]> };
  secondaries?: RowsByAlias;
}

export type BulkValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  db: QueryClient,
  req: ApiRequest,
  items: BulkValidatorItem<F>[]
) => Promise<ValidationError[]> | ValidationError[];
