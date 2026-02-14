import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(ROOT, 'dist/bin/generate-schema.js');

const TEST_ENV = {
  ...process.env,
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5433',
  POSTGRES_USER: 'test',
  POSTGRES_PASSWORD: 'test',
  POSTGRES_DB: 'testdb',
};

function runCli(cwd) {
  return execFileSync('node', [CLI_PATH], {
    cwd,
    env: TEST_ENV,
    encoding: 'utf-8',
  });
}

describe('CLI generate-schema', () => {
  let tmpDir;
  let outputDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlapi-test-'));
    outputDir = path.join(tmpDir, 'schemas');

    fs.writeFileSync(
      path.join(tmpDir, 'sqlapi.config.js'),
      `export default { outputDir: ${JSON.stringify(outputDir)}, schema: 'public' };\n`
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates schema files on first run', () => {
    const result = runCli(tmpDir);

    assert.ok(result.includes('created'));

    const files = fs.readdirSync(outputDir);
    assert.ok(files.includes('SchemaCustomer.ts'));
    assert.ok(files.includes('SchemaProduct.ts'));
    assert.ok(files.includes('SchemaCustomerOrder.ts'));
  });

  it('generated files have correct content', () => {
    const content = fs.readFileSync(
      path.join(outputDir, 'SchemaCustomer.ts'),
      'utf-8'
    );
    assert.ok(content.includes('tableName: "customer"'));
    assert.ok(content.includes('$id: "SchemaCustomer"'));
    assert.ok(content.includes('taxNumber'));
  });

  it('shows untouched on second run', () => {
    const result = runCli(tmpDir);

    assert.ok(result.includes('untouched'));
    assert.ok(result.includes('up to date'));
  });

  it('removes orphan Schema files', () => {
    fs.writeFileSync(path.join(outputDir, 'SchemaOldTable.ts'), '// orphan');

    const result = runCli(tmpDir);

    assert.ok(result.includes('removed'));
    assert.ok(!fs.existsSync(path.join(outputDir, 'SchemaOldTable.ts')));
  });
});
