import type { ApiRequest } from './request.js';
import type { QueryClient } from '../lib/db.js';
import type { TableConfig } from './table.js';
import type { TenantContext } from './tenant.js';
import type { JoinFetchRequest, JoinGroupRequest, JoinRefFilter } from './join.js';
import type { RowsByAlias } from './db.js';
import type { FilterRecord, SearchCondition } from './conditions.js';

export interface Paginator {
  page: number;
  itemsPerPage: number;
}

/** The aggregate functions a search may compute over all matching rows: those of joinGroup. */
export const COMPUTE_FNS = ['min', 'max', 'sum', 'avg', 'count', 'distinctCount'] as const;
export type ComputeFn = (typeof COMPUTE_FNS)[number];

/**
 * Aggregates over ALL rows matching the search, whatever page is returned, by function:
 * `{ sum: ['total'], count: ['id'] }`. Each lands in `result.computed.<fn>.<field>`; no
 * paginator is needed.
 */
export type ComputeRequest = Partial<Record<ComputeFn, string[]>>;

/** `result.computed`: one value per requested function and field. */
export type ComputedResult = Partial<Record<ComputeFn, Record<string, unknown>>>;

export interface SearchParams {
  db: QueryClient;
  tableConf: TableConfig;
  filters?: FilterRecord;
  conditions?: SearchCondition[];
  joinMustExist?: Record<string, JoinRefFilter>;
  joinMultiple?: Record<string, JoinFetchRequest>;
  joinGroup?: Record<string, JoinGroupRequest>;
  joinLeft?: Record<string, JoinFetchRequest>;
  orderBy?: string;
  paginator?: Paginator;
  /** Aggregates over all matching rows; see `ComputeRequest`. */
  compute?: ComputeRequest;
  /**
   * Fields to project into `main` rows: schema fields and computed fields alike. Omitted,
   * every readable schema field is returned and no computed field. The primary key, the
   * fields the requested joins correlate on and, with `distinctResults`, the ORDER BY fields
   * are always projected: the response and the side queries need them. An unknown or
   * `readExclude`d name is a 400 at `select.<i>`.
   */
  select?: string[];
  tenant?: TenantContext;
  /**
   * Row cap applied to the main query when no `paginator` is supplied, bounding an otherwise
   * unbounded "fetch everything" search. Ignored when a paginator is present (the page size
   * governs the LIMIT). Left undefined by programmatic callers (trusted); the HTTP search route
   * sets it from `maxItemsPerPage`.
   */
  maxRows?: number;
  /** Handed to the `afterRead` hook; absent for a programmatic caller that did not pass one. */
  request?: ApiRequest;
}

export interface PaginationResult {
  total: number;
  pages: number;
  paginator: Paginator;
}

export interface SearchResult {
  main: Record<string, unknown>[];
  joinMultiple?: RowsByAlias;
  joinLeft?: RowsByAlias;
  joinGroup?: Record<string, Record<string, unknown>>;
  /** Present when `compute` was requested: aggregates over every matching row. */
  computed?: ComputedResult;
  pagination?: PaginationResult;
}
