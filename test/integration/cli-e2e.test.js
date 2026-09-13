import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DIALECT } from './_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(ROOT, 'dist/bin/generate-schema.js');

// Dialect-specific env and config
const DIALECT_ENV = DIALECT === 'postgres'
  ? {
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: '5433',
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'testdb',
    }
  : {
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3307',
      MYSQL_USER: 'test',
      MYSQL_PASSWORD: 'test',
      MYSQL_DB: 'testdb',
    };

const TEST_ENV = { ...process.env, ...DIALECT_ENV };

const CONFIG_SCHEMA = DIALECT === 'postgres' ? 'public' : 'testdb';

function runCli(cwd, extraArgs = []) {
  return execFileSync('node', [CLI_PATH, ...extraArgs], {
    cwd,
    env: TEST_ENV,
    encoding: 'utf-8',
  });
}

describe(`[${DIALECT}] CLI generate-schema`, () => {
  let tmpDir;
  let outputDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sqlapi-test-${DIALECT}-`));
    outputDir = path.join(tmpDir, 'schemas');

    // CLI appends /schemas/ to outputDir, so point config at tmpDir
    fs.writeFileSync(
      path.join(tmpDir, 'sqlapi.config.js'),
      `export default { outputDir: ${JSON.stringify(tmpDir)}, schema: '${CONFIG_SCHEMA}', dialect: '${DIALECT}' };\n`
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

describe(`[${DIALECT}] CLI generate-schema with excludeColumns`, () => {
  let tmpDir;
  let outputDir;

  function writeConfig(excludeColumns) {
    fs.writeFileSync(
      path.join(tmpDir, 'sqlapi.config.js'),
      `export default { outputDir: ${JSON.stringify(tmpDir)}, schema: '${CONFIG_SCHEMA}', ` +
      `dialect: '${DIALECT}', excludeColumns: ${JSON.stringify(excludeColumns)} };\n`
    );
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sqlapi-excl-${DIALECT}-`));
    outputDir = path.join(tmpDir, 'schemas');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drops the excluded columns from the generated Schema and reports them', () => {
    writeConfig(['customer.tax_number', '*.fiscal_code', 'computed_line.subtotal']);

    const result = runCli(tmpDir);
    const reportLine = result.split('\n').find((l) => l.includes('Excluded by config (excludeColumns):'));
    assert.ok(reportLine, result);
    for (const entry of ['customer.tax_number', 'customer.fiscal_code', 'computed_line.subtotal']) {
      assert.ok(reportLine.includes(entry), `${entry} missing from: ${reportLine}`);
    }

    const customer = fs.readFileSync(path.join(outputDir, 'SchemaCustomer.ts'), 'utf-8');
    assert.ok(!customer.includes('taxNumber'), 'taxNumber still in fields/colMap');
    assert.ok(!customer.includes('fiscalCode'), 'fiscalCode still in fields/colMap');
    assert.ok(customer.includes('phoneNumber'), 'sibling column must survive');
    assert.ok(customer.includes('primaryKey: ["id"]'));

    // A database-computed column leaves generatedFields with the field itself.
    const computed = fs.readFileSync(path.join(outputDir, 'SchemaComputedLine.ts'), 'utf-8');
    assert.ok(!computed.includes('subtotal'));
    assert.ok(computed.includes('generatedFields: ["statusCode"]'), computed);
  });

  it('brings the column back when the entry is removed', () => {
    writeConfig([]);

    const result = runCli(tmpDir);
    assert.ok(result.includes('updated'));

    const customer = fs.readFileSync(path.join(outputDir, 'SchemaCustomer.ts'), 'utf-8');
    assert.ok(customer.includes('taxNumber'));
  });

  it('refuses a primary key column with a non-zero exit', () => {
    writeConfig(['*.id']);

    assert.throws(
      () => runCli(tmpDir),
      (err) => err.status !== 0 && /primary key column/.test(`${err.stdout}${err.stderr}`)
    );
  });
});
