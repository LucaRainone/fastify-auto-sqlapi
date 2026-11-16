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

describe('public types', () => {
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
