/**
 * Build a plain Error decorated with `statusCode` (and optionally `validationErrors`),
 * which Fastify reads to emit the corresponding HTTP response.
 *
 * Using a function instead of a custom class keeps the throw sites lightweight
 * and matches the existing convention across the codebase.
 */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}
