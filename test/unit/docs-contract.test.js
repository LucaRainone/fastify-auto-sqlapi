// The documentation checked against the code: every fact the docs state that the code also
// knows — a link, a number, an error code, a config key, an option, a code sample — is read from
// the code here, so docs that drift from it fail `npm run verify` instead of waiting for a review.
//
// What it cannot check is prose describing behavior ("a hook's 4xx is rendered as is"): that
// belongs to the test of the behavior itself.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, SyntaxKind, ts } from 'ts-morph';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { ALLOWED_METHODS, MAX_CONDITIONS, MAX_ORDER_BY_PARTS, MAX_ORDER_BY_LENGTH } = await import(
  path.join(ROOT, 'dist/lib/condition-methods.js')
);
const { DEFAULT_MAX_ITEMS_PER_PAGE, DEFAULT_MAX_BULK_ITEMS, DEFAULT_ITEMS_PER_PAGE } = await import(
  path.join(ROOT, 'dist/types/plugin.js')
);
const { buildTableMap, generateSchemaFile } = await import(path.join(ROOT, 'dist/lib/cli/schema-codegen.js'));

/** The docs written for the library's users: they must describe 1.0 as it is. */
const CONSUMER_DOCS = ['README.md', 'AGENTS.md', 'AGENTS_BACKEND.md', 'AGENTS_FRONTEND.md'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ─── Markdown reading ───────────────────────────────────────

/** Fenced blocks, with their fence info and the line they open on. */
function codeBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    const body = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    blocks.push({ lang: open[1], info: open[2].trim(), code: body.join('\n'), line: start + 1 });
  }
  return blocks;
}

/** The text outside fenced blocks, line numbers preserved. */
function prose(md) {
  let inFence = false;
  return md.split('\n').map((line) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

/** A prose line without its inline code spans: what a reader reads as words. */
const withoutInlineCode = (line) => line.replace(/`[^`]*`/g, '');

/** Every identifier a doc shows as code: in fenced blocks or in inline code spans. */
function codeTokens(md) {
  const tokens = new Set();
  const add = (text) => {
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) tokens.add(m[0]);
  };
  for (const b of codeBlocks(md)) add(b.code);
  for (const line of prose(md)) for (const m of line.matchAll(/`([^`]+)`/g)) add(m[1]);
  return tokens;
}

/** GitHub's heading anchors (github-slugger), duplicates suffixed -1, -2… */
function anchors(md) {
  const seen = new Map();
  const out = new Set();
  for (const line of prose(md)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (!h) continue;
    const text = h[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

// ─── What the package ships ─────────────────────────────────

const pkg = JSON.parse(read('package.json'));

/** Whether npm publishes this repo-relative path, from package.json `files`. */
function isShipped(rel) {
  if (['README.md', 'LICENSE', 'package.json'].includes(rel)) return true;
  const matches = (pattern) => rel === pattern || rel.startsWith(`${pattern}/`);
  const included = pkg.files.filter((f) => !f.startsWith('!')).some(matches);
  const excluded = pkg.files.filter((f) => f.startsWith('!')).map((f) => f.slice(1)).some(matches);
  return included && !excluded;
}

function markdownUnder(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return markdownUnder(rel);
    return e.name.endsWith('.md') ? [rel] : [];
  });
}

/** Every markdown file npm publishes. */
const SHIPPED_DOCS = [...CONSUMER_DOCS, 'CHANGELOG.md', 'BREAKING_CHANGES.md', ...markdownUnder('docs')]
  .filter(isShipped);

// ─── Links ──────────────────────────────────────────────────

describe('docs contract: links', () => {
  it('every relative link and anchor in the shipped docs resolves to a file of the package', () => {
    const problems = [];
    for (const doc of SHIPPED_DOCS) {
      const md = read(doc);
      prose(md).forEach((line, i) => {
        for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
          const target = m[1];
          if (/^[a-z]+:/i.test(target)) continue; // http(s), mailto
          const at = `${doc}:${i + 1} → ${target}`;
          const [file, anchor] = target.split('#');
          const rel = file ? path.posix.normalize(path.posix.join(path.posix.dirname(doc), file)) : doc;
          const abs = path.join(ROOT, rel);
          if (!fs.existsSync(abs)) { problems.push(`${at}: no such file`); continue; }
          if (fs.statSync(abs).isDirectory()) { problems.push(`${at}: a directory, which npm renders as nothing`); continue; }
          if (!isShipped(rel)) { problems.push(`${at}: not in the npm package`); continue; }
          if (anchor && rel.endsWith('.md') && !anchors(read(rel)).has(anchor)) {
            problems.push(`${at}: no heading with that anchor`);
          }
        }
      });
    }
    assert.deepEqual(problems, []);
  });
});

// ─── Numbers ────────────────────────────────────────────────

describe('docs contract: the numbers the docs state are the code\'s', () => {
  // Each pattern names one constant; a pattern that matches nothing fails, so a reworded
  // sentence cannot silently drop out of the check.
  const FACTS = [
    { what: 'condition operators', re: /(\d+) operators/g, value: ALLOWED_METHODS.length },
    { what: 'MAX_CONDITIONS', re: /(\d+) `conditions`/g, value: MAX_CONDITIONS },
    { what: 'MAX_ORDER_BY_PARTS', re: /(\d+) `orderBy` parts/g, value: MAX_ORDER_BY_PARTS },
    { what: 'MAX_ORDER_BY_LENGTH', re: /(\d+) chars/g, value: MAX_ORDER_BY_LENGTH },
    { what: 'DEFAULT_MAX_ITEMS_PER_PAGE', re: /maxItemsPerPage`? ?(?::|\()\s*(\d+)/g, value: DEFAULT_MAX_ITEMS_PER_PAGE },
    { what: 'DEFAULT_MAX_BULK_ITEMS', re: /maxBulkItems`? ?(?::|\()\s*(\d+)/g, value: DEFAULT_MAX_BULK_ITEMS },
    { what: 'DEFAULT_ITEMS_PER_PAGE', re: /itemsPerPage` defaults to (\d+)/g, value: DEFAULT_ITEMS_PER_PAGE },
  ];

  for (const { what, re, value } of FACTS) {
    it(`${what} is stated as ${value} wherever the docs give it`, () => {
      const found = [];
      for (const doc of CONSUMER_DOCS) {
        read(doc).split('\n').forEach((line, i) => {
          for (const m of line.matchAll(re)) found.push({ at: `${doc}:${i + 1}`, n: Number(m[1]) });
        });
      }
      assert.ok(found.length > 0, `no doc states ${what}: the pattern ${re} matched nothing`);
      assert.deepEqual(found.filter((f) => f.n !== value), []);
    });
  }
});

// ─── Error codes ────────────────────────────────────────────

/** The machine codes the engines and routes put in `fields[].code`, read from the source. */
function sourceErrorCodes() {
  const project = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src/lib/**/*.ts'), path.join(ROOT, 'src/routes/**/*.ts')]);
  const codes = new Set();
  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().includes('/lib/cli/')) continue; // codegen: templates for the user's code
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const [first] = call.getArguments();
      if (call.getExpression().getText() === 'err400' && first?.isKind(SyntaxKind.StringLiteral)) {
        codes.add(first.getLiteralValue());
      }
    }
    for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const init = prop.getInitializer();
      if (prop.getName() === 'code' && init?.isKind(SyntaxKind.StringLiteral)) codes.add(init.getLiteralValue());
    }
  }
  return codes;
}

describe('docs contract: error codes', () => {
  it('every code the engines and routes answer with is listed in AGENTS_FRONTEND, and every listed engine code exists', () => {
    const line = read('AGENTS_FRONTEND.md').split('\n').find((l) => l.includes('or an engine code:'));
    assert.ok(line, 'AGENTS_FRONTEND.md has no "or an engine code:" list');
    const [ajvPart, enginePart] = line.split('or an engine code:');
    const listed = (text) => new Set([...text.matchAll(/`([a-z][a-zA-Z]*(?:_[a-z]+)*)`/g)].map((m) => m[1]));
    const documented = new Set([...listed(ajvPart), ...listed(enginePart)]);
    const engineListed = [...listed(enginePart)].filter((c) => c.includes('_'));

    const source = sourceErrorCodes();
    assert.ok(source.size > 10, `only ${source.size} codes found in the source: the extraction broke`);
    assert.deepEqual([...source].filter((c) => !documented.has(c)).sort(), [], 'codes the source emits, missing from the docs');
    assert.deepEqual(engineListed.filter((c) => !source.has(c)).sort(), [], 'engine codes the docs list, emitted nowhere');
  });
});

// ─── Keys and options ───────────────────────────────────────

/** The property names of an exported type of the published entry, union members included. */
function publicTypeKeys(project, name) {
  const decl = project.getSourceFileOrThrow(path.join(ROOT, 'dist/index.d.ts')).getExportedDeclarations().get(name)?.[0];
  assert.ok(decl, `${name} is not exported from fastify-auto-sqlapi`);
  const type = decl.getType();
  const members = type.isUnion() ? type.getUnionTypes() : [type];
  return [...new Set(members.flatMap((t) => t.getProperties().map((p) => p.getName())))];
}

describe('docs contract: every key of the public config and context types is documented', () => {
  let project;
  let backendTokens;
  before(() => {
    project = new Project({ compilerOptions: { strict: true, skipLibCheck: true } });
    project.addSourceFileAtPath(path.join(ROOT, 'dist/index.d.ts'));
    project.resolveSourceFileDependencies();
    backendTokens = codeTokens(read('AGENTS_BACKEND.md'));
  });

  const TYPES = [
    'CliConfig', 'SqlApiPluginOptions', 'SwaggerOptions', 'DbErrorMapping', 'SqlApiOptions',
    'TableDefinition', 'ExtendedConditionContext', 'BuildRelationOptions', 'TenantScope',
    'ComputedFieldContext', 'ComputedFieldExpr',
    'ValidateContext', 'ValidateParent', 'BulkValidateContext', 'BulkValidatorItem',
    'WriteHookContext', 'AfterInsertContext', 'AfterReadContext', 'DeleteHookContext', 'BulkDeleteHookContext',
  ];
  for (const name of TYPES) {
    it(`every key of ${name} appears as code in AGENTS_BACKEND`, () => {
      const missing = publicTypeKeys(project, name).filter((k) => !backendTokens.has(k));
      assert.deepEqual(missing, []);
    });
  }
});

/** The options each bundled CLI accepts, read from its `parseArgs({ … })` call. */
function cliOptions() {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(path.join(ROOT, 'src/bin/generate-*.ts'));
  const options = new Set();
  for (const sf of project.getSourceFiles()) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'parseArgs') continue;
      const spec = call.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
      for (const p of spec?.getProperties() ?? []) options.add(`--${p.getName()}`);
    }
  }
  return options;
}

describe('docs contract: CLI options', () => {
  it('every CLI option is documented in AGENTS_BACKEND, and every option the docs name exists', () => {
    const options = cliOptions();
    assert.ok(options.size > 2, 'no parseArgs options found: the extraction broke');
    const backend = read('AGENTS_BACKEND.md');
    assert.deepEqual([...options].filter((o) => !backend.includes(o)), [], 'undocumented CLI options');

    const named = [];
    for (const doc of CONSUMER_DOCS) {
      read(doc).split('\n').forEach((line, i) => {
        if (!/sqlapi-generate|`--/.test(line)) return;
        for (const m of line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) {
          if (!options.has(m[0])) named.push(`${doc}:${i + 1} ${m[0]}`);
        }
      });
    }
    assert.deepEqual(named, [], 'CLI options the docs name that the CLI refuses');
  });
});

// ─── Glossary ───────────────────────────────────────────────

describe('docs contract: one name per concept', () => {
  // Retired words of docs/GLOSSARY.md that have no other meaning in these docs, so they can be
  // refused wherever they appear as prose. Inline code is exempt: it may name a retired key.
  const RETIRED = [
    { re: /\bnested\b/i, use: 'child rows (Secondaries)' },
    { re: /\bchildren\b/i, use: 'child rows (Secondaries)' },
    { re: /\bhost\b/i, use: 'main row, or parent in a child validate' },
    { re: /\bselection\b/i, use: 'select' },
    { re: /\brecord not found\b/i, use: 'row not found (record is a hook word)' },
  ];

  it('the consumer docs use no retired term in prose, nor in the comments of their samples', () => {
    const hits = [];
    const check = (doc, lineNo, text) => {
      for (const { re, use } of RETIRED) {
        const m = re.exec(withoutInlineCode(text));
        if (m) hits.push(`${doc}:${lineNo} "${m[0]}" → ${use}`);
      }
    };
    for (const doc of CONSUMER_DOCS) {
      const md = read(doc);
      prose(md).forEach((line, i) => check(doc, i + 1, line));
      for (const block of codeBlocks(md)) {
        block.code.split('\n').forEach((line, i) => {
          // A `//` or `#` comment is prose to the reader; `://` in a URL is not one.
          const comment = /(?:^|\s)(?:\/\/|#)\s(.*)$/.exec(line);
          if (comment) check(doc, block.line + 1 + i, comment[1]);
        });
      }
    }
    assert.deepEqual(hits, []);
  });
});

// ─── Code samples ───────────────────────────────────────────

/**
 * The tables the samples import Schemas of, generated with the CLI's own codegen so the
 * samples are checked against what a user really gets.
 */
const SAMPLE_TABLES = {
  customer: ['id:int4:pk', 'name:text', 'email:text', 'code:text', 'organization_id:int4', 'created_at:timestamp',
    'created_by:int4', 'updated_at:timestamp', 'is_admin:bool', 'password_hash:text', 'search_vector:text',
    'first_name:text', 'last_name:text', 'ssn:text', 'order_date:date', 'metadata:jsonb', 'role:text', 'salary:numeric'],
  order: ['id:int4:pk', 'customer_id:int4', 'total:numeric', 'status:text'],
  session: ['id:int4:pk', 'created_by:int4', 'updated_by:int4'],
  user: ['id:int4:pk', 'name:text'],
  request: ['id:int4:pk', 'organization_id:int4', 'in_progress_since:timestamp', 'in_progress_by:int4'],
};

function writeSampleSchemas(dir) {
  const rows = Object.entries(SAMPLE_TABLES).flatMap(([table, cols]) => cols.map((c) => {
    const [column_name, udt_name, pk] = c.split(':');
    return { table_name: table, column_name, udt_name, column_default: null, is_nullable: pk ? 'NO' : 'YES', is_primary: !!pk };
  }));
  const map = buildTableMap(rows);
  for (const [schemaName, t] of Object.entries(map)) {
    fs.writeFileSync(path.join(dir, `${schemaName}.ts`),
      generateSchemaFile(schemaName, t.name, t.fields, t.colMap, t.primary, t.generated, t.isView, t.uniqueKeys));
  }
  fs.writeFileSync(path.join(dir, 'dbTables.ts'),
    "import type { DbTables } from 'fastify-auto-sqlapi';\nexport declare const dbTables: DbTables;\n" +
    'export declare const publicTables: DbTables;\n');
  fs.writeFileSync(path.join(dir, 'crypto.ts'), 'export declare function decrypt(value: string): string;\n');
}

/**
 * A sample as a module of its own. Relative imports point at the generated Schemas. The fence
 * info says what the sample is when it is not a whole module:
 * - `ts signature`: a reference listing (`sqlApi.get(table, id, req?)`), not code; skipped.
 * - `ts in=defineTable`: keys of a `defineTable({ … })` call, checked inside one.
 * - `ts in=app`: application code using the library's exports and the user's `dbTables`
 *   without spelling out the imports.
 */
const APP_PRELUDE =
  "import { fastifyAutoSqlApi, createSqlApi, createQueryClient, pgQueryable, mysqlQueryable, ConditionBuilder, " +
  "TENANT_ADMIN, Type, defineTable, buildRelation, httpError } from 'fastify-auto-sqlapi';\n" +
  "import type { TenantScope } from 'fastify-auto-sqlapi';\n" +
  "import { dbTables, publicTables } from './dbTables.js';\n" +
  "import { SchemaSession, SchemaUser, SchemaCustomer, SchemaOrder, SchemaRequest } from './SchemaSession.js';\n";

function sampleModule(block) {
  let code = block.code.replace(/from '(?:\.{1,2}\/)+(?:[\w-]+\/)*([\w-]+)\.js'/g, "from './$1.js'");
  if (block.info === 'in=defineTable') {
    code = `${APP_PRELUDE}import { SchemaCustomer as Schema } from './SchemaCustomer.js';\n` +
      `defineTable({ primary: 'id', schema: Schema,\n${code}\n});\n`;
  } else if (block.info === 'in=app') {
    code = APP_PRELUDE + code;
  } else if (block.info) {
    throw new Error(`unknown fence info '${block.info}' at line ${block.line}`);
  }
  return `${code}\nexport {};\n`;
}

describe('docs contract: code samples', () => {
  let dir;
  before(() => {
    // Inside the repo, so the samples resolve 'fastify', 'pg' and their @types like a user's code.
    const cache = path.join(ROOT, 'node_modules/.cache');
    fs.mkdirSync(cache, { recursive: true });
    dir = fs.mkdtempSync(path.join(cache, 'sqlapi-docs-'));
    writeSampleSchemas(dir);
    // One module re-exporting the sample Schemas, for fragments naming several.
    fs.writeFileSync(path.join(dir, 'SchemaSession.ts'), fs.readFileSync(path.join(dir, 'SchemaSession.ts'), 'utf-8') +
      "export { SchemaUser } from './SchemaUser.js';\nexport { SchemaCustomer } from './SchemaCustomer.js';\n" +
      "export { SchemaOrder } from './SchemaOrder.js';\nexport { SchemaRequest } from './SchemaRequest.js';\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('every ts block of the consumer docs typechecks against the published types', () => {
    const project = new Project({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true,
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: false,
        paths: { 'fastify-auto-sqlapi': [path.join(ROOT, 'dist/index.d.ts')] },
        typeRoots: [path.join(ROOT, 'node_modules/@types')], types: ['node'],
      },
    });
    project.addSourceFileAtPath(path.join(__dirname, 'docs-contract/ambient.d.ts'));
    for (const f of fs.readdirSync(dir)) project.addSourceFileAtPath(path.join(dir, f));

    const origin = new Map();
    let checked = 0;
    for (const doc of CONSUMER_DOCS) {
      for (const block of codeBlocks(read(doc))) {
        if (!['ts', 'typescript'].includes(block.lang) || block.info === 'signature') continue;
        const file = path.join(dir, `${doc.replace('.md', '')}-L${block.line}.ts`);
        project.createSourceFile(file, sampleModule(block), { overwrite: true });
        origin.set(file, `${doc}:${block.line}`);
        checked++;
      }
    }
    assert.ok(checked > 5, `only ${checked} samples found`);

    const errors = project.getPreEmitDiagnostics()
      .map((d) => {
        const file = d.getSourceFile()?.getFilePath();
        const where = origin.get(file) ?? path.basename(file ?? '?');
        const message = ts.flattenDiagnosticMessageText(d.compilerObject.messageText, ' ');
        return `${where} (sample line ${d.getLineNumber()}): ${message}`;
      });
    assert.deepEqual(errors, []);
  });
});
