/**
 * Answers "does this already exist?" in one command, so the answer is never a guess.
 *
 *   npm run find-similar -- "parse ISO date with timezone"
 *
 * Fuzzy-matches docs/INDEX.md entries locally — no embeddings, no API key, no server.
 * The point is not semantic sophistication; it is that searching costs less than deciding
 * whether to bother searching.
 */
import Fuse from 'fuse.js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const INDEX = `${ROOT}docs/INDEX.md`;
const MARKER = `${ROOT}node_modules/.cache/find-similar-ran`;
const LIMIT = 5;

/** Consumed by the new-file guard hook, so complying with it costs exactly one command. */
function markSearched(): void {
  try {
    mkdirSync(dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, new Date().toISOString());
  } catch {
    // The marker is a convenience, never a requirement.
  }
}

type Item = { name: string; signature: string; kind: string; doc: string; file: string };

function parseIndex(): Item[] {
  let markdown: string;
  try {
    markdown = readFileSync(INDEX, 'utf8');
  } catch {
    process.stderr.write('docs/INDEX.md not found. Run `npm run index` first.\n');
    process.exit(1);
  }

  const items: Item[] = [];
  let file = '';
  for (const line of markdown.split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading?.[1]) {
      file = heading[1];
      continue;
    }
    const entry = /^- `([^`]+)` \*([^*]+)\*(?: — (.*))?$/.exec(line);
    if (entry?.[1]) {
      const signature = entry[1];
      items.push({
        name: /^[A-Za-z0-9_$]+/.exec(signature)?.[0] ?? signature,
        signature,
        kind: entry[2] ?? '',
        doc: entry[3] ?? '',
        file,
      });
    }
  }
  return items;
}

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  process.stderr.write('Usage: npm run find-similar -- "<what you are about to build>"\n');
  process.exit(1);
}

const items = parseIndex();
const fuse = new Fuse(items, {
  keys: [
    { name: 'name', weight: 3 },
    { name: 'doc', weight: 2 },
    { name: 'signature', weight: 1 },
    { name: 'file', weight: 1 },
  ],
  includeScore: true,
  threshold: 0.45,
  ignoreLocation: true,
  minMatchCharLength: 3,
});

const results = fuse.search(query, { limit: LIMIT });
markSearched();

if (results.length === 0) {
  process.stdout.write(
    `No match for "${query}" among ${items.length} declarations.\n` +
      'Nothing similar exists — create it in the right module and export it there.\n',
  );
} else {
  // Ranked, not scored: Fuse's raw score punishes long prose queries against short symbol
  // names, so a correct top hit can read as "7% match" and get dismissed. Rank is honest.
  process.stdout.write(`Top ${results.length} of ${items.length} declarations for "${query}":\n\n`);
  results.forEach(({ item }, i) => {
    const doc = item.doc ? `\n     ${item.doc}` : '';
    process.stdout.write(`  ${i + 1}. ${item.signature}  [${item.kind}]\n`);
    process.stdout.write(`     ${item.file}${doc}\n\n`);
  });
  process.stdout.write('Extend or generalise a match instead of forking it.\n');
}
