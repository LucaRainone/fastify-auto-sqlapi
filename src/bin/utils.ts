import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load .env file from cwd if it exists.
 * Does not override already-set environment variables.
 */
export function loadEnvFile(envFile?: string): void {
  const envPath = resolve(process.cwd(), envFile || '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export const CONSOLE_COLORS = {
  black: 30,
  gray: 90,
  red: 31,
  green: 32,
  yellow: 33,
  magenta: 35,
  cyan: 36,
} as const;

export function displayAsTableRow(
  pref: string,
  value: string,
  distance: number,
  color: number = 0
): void {
  const len = pref.length;
  let text = pref + ' \x1b[' + color + 'm';
  for (let i = 0; i < distance - len; i++) {
    text += '_';
  }
  text += ' ' + value + '\x1b[0m';
  console.log(text);
}

export function display(text: string, color: number = 0): void {
  console.log('\x1b[' + color + 'm' + text + '\x1b[0m');
}

export function error(text: string): void {
  display(text, CONSOLE_COLORS.red);
}

type ArgSpec =
  | { type: 'value' }
  | { type: 'flag' }
  | { type: 'list' };

type ArgValue<S extends ArgSpec> =
  S['type'] extends 'flag' ? boolean :
  S['type'] extends 'list' ? string[] :
  string | undefined;

/**
 * Tiny declarative argv parser for the bundled CLIs.
 * - `value`  → recognized as `--name X`, last value wins
 * - `flag`   → recognized as `--name`, default false
 * - `list`   → comma-separated `--name a,b,c`; can also accept positional comma-/space- separated tokens
 *
 * Positional tokens (non-`--`) are accumulated into `positional`. List specs auto-merge those tokens
 * (split on ',') into the list as well, supporting both "a b" and "a,b" CLI shapes.
 */
export function parseArgs<S extends Record<string, ArgSpec>>(
  spec: S,
  argv = process.argv.slice(2)
): { [K in keyof S]: ArgValue<S[K]> } & { positional: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = { positional: [] };
  for (const [name, def] of Object.entries(spec)) {
    out[name] = def.type === 'flag' ? false : def.type === 'list' ? [] : undefined;
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const def = spec[name];
      if (!def) continue;
      if (def.type === 'flag') {
        out[name] = true;
      } else if (def.type === 'value' && i + 1 < argv.length) {
        out[name] = argv[++i];
      } else if (def.type === 'list' && i + 1 < argv.length) {
        const next = argv[++i];
        for (const part of next.split(',')) {
          const t = part.trim();
          if (t) out[name].push(t);
        }
      }
    } else {
      out.positional.push(token);
      // Auto-distribute positional values into the (single) list spec, if any
      for (const [n, def] of Object.entries(spec)) {
        if (def.type === 'list') {
          for (const part of token.split(',')) {
            const t = part.trim();
            if (t) out[n].push(t);
          }
          break;
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return out as any;
}

/**
 * CLI entry-point wrapper: prints a header, awaits `fn`, and turns thrown errors into a red message
 * with a non-zero exit code (without aborting the process synchronously, so unfinished stdout flushes).
 */
export async function runCli(name: string, fn: () => Promise<void>): Promise<void> {
  display(`++++++ ${name} ++++++`, CONSOLE_COLORS.yellow);
  try {
    await fn();
  } catch (e) {
    error(`Error: ${(e as Error).message ?? String(e)}`);
    process.exitCode = 1;
  }
}
