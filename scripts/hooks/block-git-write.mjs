#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook: deny history-writing git commands.
 *
 * Committing is the human's review checkpoint — it is how new files and diffs get seen
 * before they land. Prose in CLAUDE.md is advisory; this is not.
 *
 * Exit 2 blocks the tool call and returns stderr to the agent. Staging (`git add`),
 * inspection (`status`, `diff`, `log`) and `git tag -l` stay allowed.
 */
import { readFileSync } from 'node:fs';

// Global options may carry a separate argument (`git -C <path> push`), so they are
// consumed explicitly before the subcommand is matched.
const GLOBAL_OPT = String.raw`(?:-C\s+\S+|-c\s+\S+|--git-dir[=\s]\S+|--work-tree[=\s]\S+|--exec-path[=\s]\S+|-[^\s]+)`;
const BLOCKED = new RegExp(
  String.raw`\bgit\b(?:\s+${GLOBAL_OPT})*\s+(commit|push|merge|rebase|tag|revert|reset)(?:\s|$)`,
);
const TAG_READONLY = /\bgit\s+tag\s+(-l\b|--list\b|-n\d*\b)/;

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // Malformed payload: do not block on hook failure.
}

const command = payload?.tool_input?.command ?? '';
const match = BLOCKED.exec(command);

if (match && !TAG_READONLY.test(command)) {
  process.stderr.write(
    `Blocked: \`git ${match[1]}\` is the human's decision, always.\n\n` +
      `Verify your work without touching history:\n` +
      `  npm run check    fast — eslint + tsc\n` +
      `  npm run verify   full gate — check, build, dup, depcruise, knip, unit tests\n\n` +
      `Then report the result and stop. \`git add\` is allowed if staging helps the review.\n` +
      `If the user needs to run it themselves, suggest they type: ! git ${match[1]} ...\n`,
  );
  process.exit(2);
}

process.exit(0);
