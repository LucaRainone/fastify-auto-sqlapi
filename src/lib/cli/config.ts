import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { SqlApiConfig } from '../../types.js';

const DEFAULTS: SqlApiConfig = {
  outputDir: './src/schemas',
  schema: 'public',
};

export async function loadConfig(): Promise<SqlApiConfig> {
  const tsPath = resolve(process.cwd(), 'sqlapi.config.ts');
  const jsPath = resolve(process.cwd(), 'sqlapi.config.js');
  const configPath = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null;

  if (!configPath) {
    return { ...DEFAULTS };
  }

  try {
    const configUrl = pathToFileURL(configPath).href;
    const mod = await import(configUrl);
    const userConfig: Partial<SqlApiConfig> = mod.default ?? mod;

    return {
      ...DEFAULTS,
      ...userConfig,
    };
  } catch (err) {
    console.warn(
      `Warning: failed to load ${configPath}, using defaults. Error: ${(err as Error).message}`
    );
    return { ...DEFAULTS };
  }
}
