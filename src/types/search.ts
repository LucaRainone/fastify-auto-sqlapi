import type { ApiRequest } from './request.js';
import type { QueryClient } from '../lib/db.js';
import type { TableConfig, FilterRecord } from './table.js';
import type { TenantContext } from './tenant.js';
import type { JoinFetchRequest, JoinGroupRequest, JoinRefFilter, RowsByAlias } from './join.js';
import type { SearchCondition } from './conditions.js';

export interface Paginator {
  page: number;
  itemsPerPage: number;
}

/** The aggregate functions a search may compute over all matching rows. */
export const COMPUTE_FNS = ['min', 'max', 'sum', 'avg'] as const;
export type ComputeFn = (typeof COMPUTE_FNS)[number];

/**
 * Aggregates over ALL rows matching the search, by function: `{ sum: ['total'], max: ['total'] }`.
 * Each lands in `pagination.computed.<fn>.<field>`, so a paginator is required.
 */
export type ComputeRequest = Partial<Record<ComputeFn, string[]>>;

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
  /** One-field forms of `compute`, kept for the querystring: merged into it. */
  computeMin?: string;
  computeMax?: string;
  computeSum?: string;
  computeAvg?: string;
  /**
   * Schema fields to project into `main` rows. Omitted, every readable field is returned.
   * The primary key, the fields the requested joins correlate on and, with
   * `distinctResults`, the ORDER BY fields are always projected: the response and the side
   * queries need them. An unknown or `readExclude`d name is a 400 at `select.<i>`.
   */
  select?: string[];
  /**
   * Names of computed fields (declared on `tableConf.computedFields`) to project
   * into the main response. Each becomes an extra column on each `main[i]` row.
   */
  selectComputed?: string[];
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
  computed?: Record<string, Record<string, unknown>>;
  paginator: Paginator;
}

export interface SearchResult {
  main: Record<string, unknown>[];
  joinMultiple?: RowsByAlias;
  joinLeft?: RowsByAlias;
  joinGroup?: Record<string, Record<string, unknown>>;
  pagination?: PaginationResult;
}
