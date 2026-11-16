// The types a consumer must name to write its code are exported from the package root: a type
// that appears in a public signature but can only be reached as `SomeContext['field']` is a
// gap in the API. Checked by compiling a consumer snippet against dist/index.d.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './_harness.js';

const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');

/** The compiler diagnostics of `source`, a consumer module importing from dist/index.js. */
function diagnosticsOf(source) {
  const file = path.join(ROOT, 'test/unit/__consumer__.ts');
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (f) => (f === file ? source : readFile(f));
  host.fileExists = ((exists) => (f) => f === file || exists(f))(host.fileExists.bind(host));
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/**
 * Types a public signature names that are deliberately not exported: the building blocks of an
 * exported type (`SearchCondition` is built from the method groups), generics plumbing, and the
 * dialect and adapter internals behind `QueryClient` and `Queryable`. A consumer names the
 * exported type instead. Anything else a public signature reaches must be exported.
 */
const INTERNAL = new Set([
  'SingleValueMethods', 'BetweenMethods', 'InMethods', 'NullMethods', 'ConditionParams',
  'ExtraProps', 'TableKey',
  'SqlDialect', 'TruncateUnit',
  'PgQueryable', 'MysqlQueryable',
]);

/**
 * The package's own types reached from the exported ones — through their members, parameters
 * and return types, skipping private class members — that are not exported themselves.
 */
function unexportedPublicTypes() {
  const entry = path.join(ROOT, 'dist/index.d.ts');
  const dist = path.join(ROOT, 'dist') + path.sep;
  const program = ts.createProgram([entry], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const resolve = (s) => (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const exported = new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry))).map(resolve));

  const missing = new Set();
  const seen = new Set();
  const isPrivate = (node) =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ||
    (node.name !== undefined && ts.isPrivateIdentifier(node.name));
  const visit = (node) => {
    if (isPrivate(node)) return;
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const sym = resolve(checker.getSymbolAtLocation(ts.isTypeReferenceNode(node) ? node.typeName : node.expression));
      const decl = sym?.declarations?.[0];
      if (decl && decl.getSourceFile().fileName.startsWith(dist) && !(sym.flags & ts.SymbolFlags.TypeParameter)) {
        if (!exported.has(sym)) missing.add(sym.name);
        walk(sym);
      }
    }
    ts.forEachChild(node, visit);
  };
  const walk = (sym) => {
    if (seen.has(sym)) return;
    seen.add(sym);
    for (const decl of sym.declarations ?? []) ts.forEachChild(decl, visit);
  };
  for (const sym of exported) walk(sym);
  return [...missing].sort();
}

describe('public types', () => {
  const unexported = unexportedPublicTypes();

  it('every type a public signature reaches is exported, unless listed as internal', () => {
    assert.deepEqual(unexported.filter((name) => !INTERNAL.has(name)), []);
  });

  it('the internal list names only types a public signature still reaches', () => {
    // A stale entry excuses nothing today, and would silently excuse a regression tomorrow.
    assert.deepEqual([...INTERNAL].filter((name) => !unexported.includes(name)), []);
  });

  it('PrimaryKeyValue: the ids of a bulk delete, in sqlApi and in its hooks', () => {
    const errors = diagnosticsOf(`
      import type { PrimaryKeyValue, BulkDeleteHookContext, SqlApiBulkDeleteParams } from '../../dist/index.js';
      const single: PrimaryKeyValue = 7;
      const composite: PrimaryKeyValue = { postId: 1, tagId: 2 };
      const params: SqlApiBulkDeleteParams = { ids: [single, composite] };
      const fromHook = (ctx: BulkDeleteHookContext): PrimaryKeyValue[] => ctx.ids;
      export { params, fromHook };
    `);
    assert.deepEqual(errors, []);
  });
});
