// Allowed ConditionBuilder methods for the `conditions` search API.
// Single source of truth for both schema validation (Swagger) and runtime whitelist.

export const SINGLE_VALUE_METHODS = [
  'isEqual', 'isNotEqual',
  'isGreater', 'isNotGreater', 'isGreaterOrEqual', 'isNotGreaterOrEqual',
  'isLess', 'isNotLess', 'isLessOrEqual', 'isNotLessOrEqual',
  'isLike', 'isNotLike', 'isILike', 'isNotILike',
] as const;

export const BETWEEN_METHODS = ['isBetween', 'isNotBetween'] as const;
export const IN_METHODS = ['isIn', 'isNotIn'] as const;
export const NULL_METHODS = ['isNull', 'isNotNull'] as const;

export const ALLOWED_METHODS = [
  ...SINGLE_VALUE_METHODS, ...BETWEEN_METHODS, ...IN_METHODS, ...NULL_METHODS,
] as const;

// Runtime Sets for fast lookup
export const SINGLE_VALUE_SET = new Set<string>(SINGLE_VALUE_METHODS);
export const BETWEEN_SET = new Set<string>(BETWEEN_METHODS);
export const IN_SET = new Set<string>(IN_METHODS);
export const NULL_SET = new Set<string>(NULL_METHODS);
export const ALLOWED_SET = new Set<string>(ALLOWED_METHODS);
