#!/usr/bin/env node
/**
 * PreToolUse(Write) hook: interrupt the write-first reflex on new files under src/.
 *
 * A new file is how duplication enters: the agent cannot find what it did not search for,
 * so it writes a second version of something that already exists.
 *
 * This blocks only ONCE per search. `npm run find-similar` drops a marker; the hook
 * consumes it and lets the write through. So the cost of complying is one command, and the
 * hook can never deadlock — which is what would get it disabled.
 */
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const MARKER = resolve(process.env.CLAUDE_PROJECT_DIR ?? '.', 'node_modules/.cache/find-similar-ran');
const MARKER_TTL_MS = 30 * 60 * 1000;

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // Never block because the hook itself failed.
}

const filePath = payload?.tool_input?.file_path ?? '';
if (!filePath) process.exit(0);

const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? '.');
const rel = relative(root, resolve(filePath));

// Only new files, only inside src/.
if (!rel.startsWith('src/') || existsSync(filePath)) process.exit(0);

if (existsSync(MARKER) && Date.now() - statSync(MARKER).mtimeMs < MARKER_TTL_MS) {
  unlinkSync(MARKER); // One search buys one new file.
  process.exit(0);
}

process.stderr.write(
  `New file in src/: ${rel}\n\n` +
    `Search before writing — this is where duplication gets in:\n` +
    `  npm run find-similar -- "<what this file is for>"\n\n` +
    `Then read docs/INDEX.md for the target module and state, in your reply, which existing\n` +
    `module you evaluated and why it does not fit. Extend or generalise a match instead of\n` +
    `forking it. Re-running the search unblocks this write.\n`,
);
process.exit(2);
