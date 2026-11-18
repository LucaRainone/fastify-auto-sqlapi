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

/** Options retired in 1.0, each with what replaces it. */
const RETIRED_OPTIONS: Readonly<Record<string, string>> = {
  dialect: 'the dialect is the scheme of the connection URL (postgres://, mysql://, mariadb://)',
};

/**
 * Tiny declarative argv parser for the bundled CLIs. An option not in `spec` is an error: left
 * unread, its value would be taken for a positional table name.
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
  const out: Record<string, unknown> = { positional: [] };
  for (const [name, def] of Object.entries(spec)) {
    out[name] = def.type === 'flag' ? false : def.type === 'list' ? [] : undefined;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith('--')) {
      // An option may consume the following entry as its value.
      i += 1 + readOption(out, spec, argv, i);
    } else {
      readPositional(out, spec, token);
      i += 1;
    }
  }

  return out as { [K in keyof S]: ArgValue<S[K]> } & { positional: string[] };
}

/** Split on ',' and append the non-empty tokens. */
function pushCsv(target: string[], raw: string): void {
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t) target.push(t);
  }
}

/**
 * Read one `--name [value]` option at `i`. Returns how many *extra* argv entries it
 * consumed (1 when it took the next entry as its value, 0 otherwise).
 */
function readOption(
  out: Record<string, unknown>,
  spec: Record<string, ArgSpec>,
  argv: string[],
  i: number
): number {
  const name = argv[i].slice(2);
  if (!Object.hasOwn(spec, name)) {
    if (Object.hasOwn(RETIRED_OPTIONS, name)) {
      throw new Error(`--${name} was removed in 1.0: ${RETIRED_OPTIONS[name]}`);
    }
    const known = Object.keys(spec).map((n) => '--' + n).join(', ');
    throw new Error(`unknown option --${name}. Known options: ${known}`);
  }
  const def = spec[name];

  const hasNext = i + 1 < argv.length;
  if (def.type === 'flag') {
    out[name] = true;
  } else if (def.type === 'value' && hasNext) {
    out[name] = argv[i + 1];
    return 1;
  } else if (def.type === 'list' && hasNext) {
    pushCsv(out[name] as string[], argv[i + 1]);
    return 1;
  }
  return 0;
}

/** A positional token also feeds the (single) list spec, so `a b` and `a,b` both work. */
function readPositional(
  out: Record<string, unknown>,
  spec: Record<string, ArgSpec>,
  token: string
): void {
  (out.positional as string[]).push(token);

  for (const [name, def] of Object.entries(spec)) {
    if (def.type === 'list') {
      pushCsv(out[name] as string[], token);
      break;
    }
  }
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
