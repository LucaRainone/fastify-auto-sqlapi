import type { TSchema, Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { QueryClient } from '../lib/db.js';

/**
 * Validation error tuple: [field, code] or [field, code, message].
 * - field: the field path (e.g. 'name', 'session_period[1].startDate')
 * - code: machine-readable error code (e.g. 'required', 'overlap', 'unique')
 * - message: human-readable description (defaults to code if omitted)
 */
export type ValidationError =
  | [field: string, code: string]
  | [field: string, code: string, message: string];

export type ValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  db: QueryClient,
  req: FastifyRequest,
  main: { [K in keyof F]?: Static<F[K]> },
  secondaries?: Record<string, Record<string, unknown>[]>
) => Promise<ValidationError[]> | ValidationError[];

export interface BulkValidatorItem<F extends Record<string, TSchema> = Record<string, TSchema>> {
  main: { [K in keyof F]?: Static<F[K]> };
  secondaries?: Record<string, Record<string, unknown>[]>;
}

export type BulkValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  db: QueryClient,
  req: FastifyRequest,
  items: BulkValidatorItem<F>[]
) => Promise<ValidationError[]> | ValidationError[];
