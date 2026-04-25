import type { ConditionBuilder as CB } from 'node-condition-builder';

// Methods that accept (field, value)
type SingleValueMethods =
  | 'isEqual' | 'isNotEqual'
  | 'isGreater' | 'isNotGreater' | 'isGreaterOrEqual' | 'isNotGreaterOrEqual'
  | 'isLess' | 'isNotLess' | 'isLessOrEqual' | 'isNotLessOrEqual'
  | 'isLike' | 'isNotLike' | 'isILike' | 'isNotILike';

// Methods that accept (field, from, to)
type BetweenMethods = 'isBetween' | 'isNotBetween';

// Methods that accept (field, values[])
type InMethods = 'isIn' | 'isNotIn';

// Methods that accept (field) only
type NullMethods = 'isNull' | 'isNotNull';

export type ConditionMethod = SingleValueMethods | BetweenMethods | InMethods | NullMethods;

// Params type per method category
type ConditionParams<M extends ConditionMethod> =
  M extends SingleValueMethods ? [value: Parameters<CB[M]>[1]] :
  M extends BetweenMethods ? [from: Parameters<CB[M]>[1], to: Parameters<CB[M]>[2]] :
  M extends InMethods ? [values: Parameters<CB[M]>[1]] :
  M extends NullMethods ? [] :
  never;

export type SearchCondition<F extends string = string> = {
  [M in ConditionMethod]: { field: F; method: M; params: ConditionParams<M> }
}[ConditionMethod];
