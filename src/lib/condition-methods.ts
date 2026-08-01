// Allowed ConditionBuilder methods for the `conditions` search API.
// Single source of truth for both schema validation (Swagger) and runtime whitelist.

const SINGLE_VALUE_METHODS = [
  'isEqual', 'isNotEqual',
  'isGreater', 'isNotGreater', 'isGreaterOrEqual', 'isNotGreaterOrEqual',
  'isLess', 'isNotLess', 'isLessOrEqual', 'isNotLessOrEqual',
  'isLike', 'isNotLike', 'isILike', 'isNotILike',
] as const;

const BETWEEN_METHODS = ['isBetween', 'isNotBetween'] as const;
const IN_METHODS = ['isIn', 'isNotIn'] as const;
const NULL_METHODS = ['isNull', 'isNotNull'] as const;

export const ALLOWED_METHODS = [
  ...SINGLE_VALUE_METHODS, ...BETWEEN_METHODS, ...IN_METHODS, ...NULL_METHODS,
] as const;

// Runtime Sets for fast lookup
export const SINGLE_VALUE_SET = new Set<string>(SINGLE_VALUE_METHODS);
export const BETWEEN_SET = new Set<string>(BETWEEN_METHODS);
export const IN_SET = new Set<string>(IN_METHODS);
export const NULL_SET = new Set<string>(NULL_METHODS);
export const ALLOWED_SET = new Set<string>(ALLOWED_METHODS);

/**
 * Caps on how much work one search request may ask for.
 *
 * Every dotted condition and every 3-part `orderBy` token becomes its own correlated subquery,
 * so an uncapped list turns a single request into arbitrarily many — `maxItemsPerPage` bounds
 * the rows returned, not the work done to find them. They live here, in the data module both
 * the engine and the TypeBox schema builders already share, so the request schema advertises
 * exactly the limit the engine enforces.
 */
export const MAX_CONDITIONS = 100;

/** Token cap the engine applies to `orderBy`, counted over its comma-separated parts. */
export const MAX_ORDER_BY_PARTS = 20;

/** Character cap the request schema applies to `orderBy` — generous for MAX_ORDER_BY_PARTS. */
export const MAX_ORDER_BY_LENGTH = 1024;
