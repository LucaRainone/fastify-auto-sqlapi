import type { SchemaDefinition } from './schema.js';

export type TenantId = string | number;

export interface TenantScopeDirect {
  column: string;
}

export interface TenantScopeIndirect {
  column: string;
  through: {
    schema: SchemaDefinition;
    localField: string;
    foreignField: string;
  };
}

export type TenantScope = TenantScopeDirect | TenantScopeIndirect;

export interface TenantContext {
  ids: TenantId[];
  scope: TenantScope;
}
