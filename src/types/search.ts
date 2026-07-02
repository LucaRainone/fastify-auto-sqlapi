import type { QueryClient } from '../lib/db.js';
import type { ITable, FilterRecord } from './table.js';
import type { TenantContext } from './tenant.js';
import type { JoinFetchRequest, JoinGroupRequest, JoinRefFilter } from './join.js';
import type { SearchCondition } from './conditions.js';

export interface Paginator {
  page: number;
  itemsPerPage: number;
}

export interface SearchParams {
  db: QueryClient;
  tableConf: ITable;
  filters?: FilterRecord;
  conditions?: SearchCondition[];
  joinMustExist?: Record<string, JoinRefFilter>;
  joinMultiple?: Record<string, JoinFetchRequest>;
  joinGroup?: Record<string, JoinGroupRequest>;
  joinLeft?: Record<string, JoinFetchRequest>;
  orderBy?: string;
  paginator?: Paginator;
  computeMin?: string;
  computeMax?: string;
  computeSum?: string;
  computeAvg?: string;
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
}

export interface PaginationResult {
  total: number;
  pages: number;
  computed?: Record<string, Record<string, unknown>>;
  paginator: Paginator;
}

export interface SearchResult {
  main: Record<string, unknown>[];
  joinMultiple?: Record<string, Record<string, unknown>[]>;
  joinLeft?: Record<string, Record<string, unknown>[]>;
  joinGroup?: Record<string, Record<string, unknown>>;
  pagination?: PaginationResult;
}
