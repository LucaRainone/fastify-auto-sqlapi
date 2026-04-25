import { createRequire } from 'node:module';

/**
 * Load an optional peer dependency by trying the consumer's CWD first
 * (so it works when installed via `npm install`/`npm link`), then falling
 * back to the plugin's own `node_modules` (so it works in the plugin's own tests).
 * Throws a friendly error if neither succeeds.
 */
export function loadOptionalDependency<T = unknown>(modulePath: string, installHint: string): T {
  try {
    return createRequire(process.cwd() + '/noop.js')(modulePath) as T;
  } catch {
    /* fall through to local require */
  }
  try {
    return createRequire(import.meta.url)(modulePath) as T;
  } catch {
    throw new Error(`${modulePath} is required. Install it with: ${installHint}`);
  }
}
