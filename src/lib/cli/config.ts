import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { SqlApiConfig } from '../../types.js';

const DEFAULTS: SqlApiConfig = {
  outputDir: './src/db',
  schema: 'public',
};

export async function loadConfig(): Promise<SqlApiConfig> {
  const candidates = ['sqlapi.config.ts', 'sqlapi.config.mjs', 'sqlapi.config.js'];
  const configPath = candidates
    .map((f) => resolve(process.cwd(), f))
    .find((p) => existsSync(p)) ?? null;

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
