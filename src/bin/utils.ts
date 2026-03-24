import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load .env file from cwd if it exists.
 * Does not override already-set environment variables.
 */
export function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), '.env');
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
