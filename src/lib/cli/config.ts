import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { CliConfig, DialectName } from '../../types.js';

/** The configuration the CLI runs with: the user's over the defaults. */
type ResolvedCliConfig = CliConfig & { outputDir: string; schema: string };

const DEFAULTS: ResolvedCliConfig = {
  outputDir: './src/db',
  schema: 'public',
};

const CONFIG_FILES = ['sqlapi.config.ts', 'sqlapi.config.mjs', 'sqlapi.config.js'];

/** Every key `CliConfig` has: anything else in the file is a typo the CLI would otherwise ignore. */
const KNOWN_KEYS: ReadonlySet<string> = new Set<keyof CliConfig>([
  'connection', 'outputDir', 'schema', 'excludeTables', 'excludeColumns',
]);

/** Keys retired in 1.0, each with what replaces it. */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  dialect: 'the dialect is the scheme of the connection URL (postgres://, mysql://, mariadb://)',
  envFile:
    "a .env in the current directory is read before the config; for another file, call " +
    "process.loadEnvFile('<file>') at the top of the config",
};

/**
 * Load the CLI configuration of the project in `cwd`.
 *
 * The project's `.env` is read first, so the config can name the variables it holds
 * (`connection: process.env.SHOP_DB_URL`); a variable already set in the environment wins over
 * the file. A config that fails to load, or that carries a key the CLI does not know, is an
 * error: run on a half-read config, the generator would introspect the wrong database or write
 * where nobody looks.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<ResolvedCliConfig> {
  const envPath = resolve(cwd, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const configPath = CONFIG_FILES.map((f) => resolve(cwd, f)).find((p) => existsSync(p));
  if (!configPath) return { ...DEFAULTS };

  let userConfig: CliConfig;
  try {
    const mod = await import(pathToFileURL(configPath).href);
    userConfig = mod.default ?? mod;
  } catch (err) {
    throw new Error(`failed to load ${configPath}: ${(err as Error).message}`, { cause: err });
  }

  checkConfigKeys(userConfig, configPath);
  return { ...DEFAULTS, ...userConfig };
}

function checkConfigKeys(userConfig: object, configPath: string): void {
  for (const key of Object.keys(userConfig)) {
    if (Object.hasOwn(RETIRED_KEYS, key)) {
      throw new Error(`${configPath}: '${key}' was removed in 1.0: ${RETIRED_KEYS[key]}`);
    }
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(
        `${configPath}: unknown key '${key}'. Known keys: ${[...KNOWN_KEYS].join(', ')}`
      );
    }
  }
}

/** The database the CLI introspects: its URL, and the dialect its scheme names. */
export interface DbConnection {
  dialect: DialectName;
  url: string;
}

const SCHEME_DIALECTS: Readonly<Record<string, DialectName>> = {
  'postgres:': 'postgres',
  'postgresql:': 'postgres',
  'mysql:': 'mysql',
  'mariadb:': 'mariadb',
};

/**
 * Pick the connection URL: `--url` first, then `connection` in the config, then `DATABASE_URL`.
 * There is no default database: with none of the three the CLI stops and says how to give one.
 *
 * A `connection` key present in the config but empty is an error of its own rather than a fall
 * back to `DATABASE_URL`: it is how `connection: process.env.SHOP_DB_URL` reads when that
 * variable is missing, and falling back would introspect another database without a word.
 */
export function resolveConnection(input: {
  url?: string;
  config: Pick<CliConfig, 'connection'>;
  env: NodeJS.ProcessEnv;
}): DbConnection {
  const { url, config, env } = input;
  let chosen: string | undefined;
  if (url) {
    chosen = url;
  } else if (Object.hasOwn(config, 'connection')) {
    if (!config.connection) {
      throw new Error(
        "sqlapi.config: 'connection' is empty: is the environment variable it reads set " +
        '(in the environment or in the .env of the current directory)?'
      );
    }
    chosen = config.connection;
  } else {
    chosen = env.DATABASE_URL;
  }

  if (!chosen) {
    throw new Error(
      'no database to introspect: pass --url <url>, set `connection` in sqlapi.config.ts, ' +
      'or set DATABASE_URL (in the environment or in the .env of the current directory)'
    );
  }
  return { dialect: dialectOfUrl(chosen), url: chosen };
}

/** `scheme://`: without it `host:5432` would parse as a URL whose scheme is `host:`. */
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;

function dialectOfUrl(url: string): DialectName {
  let protocol: string;
  try {
    if (!URL_SHAPE.test(url)) throw new TypeError('no scheme');
    protocol = new URL(url).protocol;
  } catch {
    // The input is not echoed: it may carry a password, and it cannot be parsed to mask it.
    throw new Error('the connection is not a valid connection URL (e.g. postgres://user:pass@host:5432/db)');
  }
  const dialect = SCHEME_DIALECTS[protocol];
  if (!dialect) {
    throw new Error(
      `unsupported connection URL scheme '${protocol}': use ` +
      Object.keys(SCHEME_DIALECTS).map((s) => `${s}//`).join(', ')
    );
  }
  return dialect;
}

/** A URL `resolveConnection` accepted, with its password replaced by `***`, for output. */
export function maskPassword(url: string): string {
  const parsed = new URL(url);
  if (!parsed.password) return url;
  parsed.password = '***';
  return parsed.href;
}
