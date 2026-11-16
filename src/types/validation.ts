import type { TSchema, Static } from 'typebox';
import type { RowsByAlias } from './db.js';
import type { HookContext } from './hooks.js';

/**
 * One entry of the `fields` array every 400 response carries, whether the error came from
 * the request schema, from a table's `validate`/`validateBulk`, or from the engine.
 *
 * - `path`: dot path of the offending value inside the request — body keys from the root
 *   (`main.name`, `upsert.orders.0.total`, `filters.status`, `conditions.2.params`,
 *   `joinMultiple.orders.select.1`), querystring and path parameters by name (`orderBy`,
 *   `itemsPerPage`, `id`). The empty string when the error is not attributable to one input.
 * - `code`: machine-readable and stable — an Ajv keyword (`required`, `type`, `maximum`…),
 *   the code a `validate` hook returned, or one of the engine's codes (`unknown_field`,
 *   `not_readable`, `unknown_alias`, `invalid_params`…, see AGENTS_FRONTEND.md).
 * - `message`: Ajv's, the engine's or an `httpError`'s description, for a developer. Absent
 *   when there is nothing to say beyond the code: on an entry `validate`/`validateBulk`
 *   returned (a hook writes no prose) and on a `dbErrors` answer.
 */
export interface ValidationField {
  path: string;
  code: string;
  message?: string;
}

/**
 * The main row a child row is written with, as the child table's `validate`/`validateBulk` sees
 * it when its rows arrive through another table's write join (ADR 0030): the alias they were
 * sent under and that table's main row, camelCase, as the request sent it.
 */
export interface ValidateParent {
  alias: string;
  main: Record<string, unknown>;
}

/**
 * `validate`: the camelCase main record of an insert or update, and the child rows it writes,
 * by alias, under the request's own section names — so an error's `path` is the request's.
 *
 * When the table's rows arrive as another table's child rows, `main` is one of them — with the
 * FK to that table's main row when the request names its key — and `parent` names that table's
 * main row; on the table's own routes `parent` is absent (ADR 0030).
 */
export interface ValidateContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends HookContext {
  main: { [K in keyof F]?: Static<F[K]> };
  upsert?: RowsByAlias;
  replace?: RowsByAlias;
  parent?: ValidateParent;
}

/**
 * What a `validate`/`validateBulk` hook returns: one `{ path, code }` per problem, rendered as
 * a field of the 400 — `path` in the grammar of `ValidationField.path` (`main.name`,
 * `upsert.orders.0.total`; in `validateBulk`, `items.3.main.code`), `code` the stable
 * code the client translates (`required`, `overlap`, `unique`). An empty array lets the write
 * through.
 */
export type ValidatorResult = Pick<ValidationField, 'path' | 'code'>[];

export type ValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  ctx: ValidateContext<F>
) => Promise<ValidatorResult> | ValidatorResult;

/** One item of a bulk upsert, as the request sent it. */
export interface BulkValidatorItem<F extends Record<string, TSchema> = Record<string, TSchema>> {
  main: { [K in keyof F]?: Static<F[K]> };
  upsert?: RowsByAlias;
  delete?: RowsByAlias;
  replace?: RowsByAlias;
}

/**
 * `validateBulk`: every item of a bulk upsert, once — or, when the table's rows arrive as
 * another table's child rows, the rows of one alias as `{ main }` items, with `parent`
 * (ADR 0030).
 */
export interface BulkValidateContext<F extends Record<string, TSchema> = Record<string, TSchema>> extends HookContext {
  items: BulkValidatorItem<F>[];
  parent?: ValidateParent;
}

export type BulkValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  ctx: BulkValidateContext<F>
) => Promise<ValidatorResult> | ValidatorResult;
