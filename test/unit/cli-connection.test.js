import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { resolveConnection, loadConfig } = await import(path.join(ROOT, 'dist/lib/cli/config.js'));
const { buildMysqlConnectionConfig } = await import(path.join(ROOT, 'dist/lib/cli/mysql-introspect.js'));
const { parseArgs } = await import(path.join(ROOT, 'dist/bin/utils.js'));

const GENERATE_SCHEMA = path.join(ROOT, 'dist/bin/generate-schema.js');

function tmpProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlapi-cli-conn-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** The environment of the test run, without the variables the CLI reads its connection from. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return env;
}

function runGenerateSchema(cwd, args = [], env = cleanEnv()) {
  const res = spawnSync('node', [GENERATE_SCHEMA, ...args], { cwd, env, encoding: 'utf-8', timeout: 20000 });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

describe('CLI connection: one URL, from the flag, the config or DATABASE_URL', () => {
  it('--url wins over the config connection and DATABASE_URL', () => {
    const conn = resolveConnection({
      url: 'postgres://flag@h/db',
      config: { connection: 'postgres://config@h/db' },
      env: { DATABASE_URL: 'postgres://env@h/db' },
    });
    assert.deepEqual(conn, { dialect: 'postgres', url: 'postgres://flag@h/db' });
  });

  it('the config connection wins over DATABASE_URL', () => {
    const conn = resolveConnection({
      config: { connection: 'mysql://config@h/db' },
      env: { DATABASE_URL: 'postgres://env@h/db' },
    });
    assert.deepEqual(conn, { dialect: 'mysql', url: 'mysql://config@h/db' });
  });

  it('DATABASE_URL is used when neither the flag nor the config names a connection', () => {
    const conn = resolveConnection({ config: {}, env: { DATABASE_URL: 'mariadb://env@h/db' } });
    assert.deepEqual(conn, { dialect: 'mariadb', url: 'mariadb://env@h/db' });
  });

  it('no connection anywhere is an error naming the three ways to give one, never a default database', () => {
    assert.throws(
      () => resolveConnection({ config: {}, env: {} }),
      (err) => /--url/.test(err.message) && /connection/.test(err.message) && /DATABASE_URL/.test(err.message)
    );
  });

  it('a config connection that resolves to nothing is an error, not a fall back to DATABASE_URL', () => {
    assert.throws(
      () => resolveConnection({ config: { connection: undefined }, env: { DATABASE_URL: 'postgres://env@h/db' } }),
      /sqlapi\.config.*connection/
    );
  });

  it('the dialect is the URL scheme', () => {
    const dialectOf = (url) => resolveConnection({ url, config: {}, env: {} }).dialect;
    assert.equal(dialectOf('postgres://u@h/db'), 'postgres');
    assert.equal(dialectOf('postgresql://u@h/db'), 'postgres');
    assert.equal(dialectOf('mysql://u@h/db'), 'mysql');
    assert.equal(dialectOf('mariadb://u@h/db'), 'mariadb');
  });

  it('an unsupported scheme is an error listing the supported ones', () => {
    assert.throws(
      () => resolveConnection({ url: 'sqlite://file.db', config: {}, env: {} }),
      (err) => /sqlite:/.test(err.message) && /postgres:\/\//.test(err.message) && /mariadb:\/\//.test(err.message)
    );
  });

  it('a string that is not a URL is an error', () => {
    assert.throws(() => resolveConnection({ url: 'localhost:5432', config: {}, env: {} }), /not a valid connection URL/);
  });
});

describe('CLI connection: a MySQL URL becomes the driver config', () => {
  it('decodes percent-encoded credentials and defaults the port', () => {
    assert.deepEqual(buildMysqlConnectionConfig('mysql://app%40corp:p%40ss%2Fw@db.local/shop'), {
      host: 'db.local',
      port: 3306,
      user: 'app@corp',
      password: 'p@ss/w',
      database: 'shop',
    });
  });

  it('a URL without a database is an error', () => {
    assert.throws(() => buildMysqlConnectionConfig('mysql://app@db.local:3307'), /database/);
  });
});

describe('CLI config: loaded after the .env, every key known', () => {
  const touched = [];
  after(() => {
    for (const key of touched) delete process.env[key];
  });

  it('reads the .env of the project before the config, so the config can name its variables', async () => {
    touched.push('SQLAPI_TEST_SHOP_URL');
    const dir = tmpProject({
      '.env': 'SQLAPI_TEST_SHOP_URL=postgres://app:secret@db/shop\n',
      'sqlapi.config.mjs': 'export default { connection: process.env.SQLAPI_TEST_SHOP_URL };\n',
    });
    const config = await loadConfig(dir);
    assert.equal(config.connection, 'postgres://app:secret@db/shop');
  });

  it('a variable already set wins over the .env', async () => {
    touched.push('SQLAPI_TEST_SET_URL');
    process.env.SQLAPI_TEST_SET_URL = 'postgres://from-env@db/shop';
    const dir = tmpProject({
      '.env': 'SQLAPI_TEST_SET_URL=postgres://from-file@db/shop\n',
      'sqlapi.config.mjs': 'export default { connection: process.env.SQLAPI_TEST_SET_URL };\n',
    });
    const config = await loadConfig(dir);
    assert.equal(config.connection, 'postgres://from-env@db/shop');
  });

  it('no config file gives the defaults', async () => {
    const config = await loadConfig(tmpProject());
    assert.equal(config.outputDir, './src/db');
    assert.equal(config.schema, 'public');
  });

  it('a config that fails to load is an error naming the file, not a silent fall back to the defaults', async () => {
    const dir = tmpProject({ 'sqlapi.config.mjs': 'export default {;\n' });
    await assert.rejects(loadConfig(dir), /sqlapi\.config\.mjs/);
  });

  it('dialect is refused: the URL scheme names it', async () => {
    const dir = tmpProject({ 'sqlapi.config.mjs': "export default { dialect: 'mysql' };\n" });
    await assert.rejects(loadConfig(dir), (err) => /dialect/.test(err.message) && /scheme/.test(err.message));
  });

  it('envFile is refused: the config loads another env file itself', async () => {
    const dir = tmpProject({ 'sqlapi.config.mjs': "export default { envFile: '.env.local' };\n" });
    await assert.rejects(loadConfig(dir), (err) => /envFile/.test(err.message) && /process\.loadEnvFile/.test(err.message));
  });

  it('an unknown key is refused, naming the keys that exist', async () => {
    const dir = tmpProject({ 'sqlapi.config.mjs': "export default { outDir: './x' };\n" });
    await assert.rejects(loadConfig(dir), (err) => /outDir/.test(err.message) && /outputDir/.test(err.message));
  });
});

describe('CLI arguments: an unknown option is refused', () => {
  it('names the option and the ones that exist', () => {
    assert.throws(
      () => parseArgs({ output: { type: 'value' } }, ['--outptu', 'x']),
      (err) => /--outptu/.test(err.message) && /--output/.test(err.message)
    );
  });

  it('--dialect is refused: the URL scheme names it', () => {
    assert.throws(
      () => parseArgs({ url: { type: 'value' } }, ['--dialect', 'mysql']),
      (err) => /--dialect/.test(err.message) && /scheme/.test(err.message)
    );
  });
});

describe('sqlapi-generate-schema: where it connects', () => {
  let dir;
  before(() => {
    dir = tmpProject({ 'sqlapi.config.mjs': 'export default {};\n' });
  });

  it('without a connection it exits non-zero saying how to give one, and connects nowhere', () => {
    const { status, output } = runGenerateSchema(dir);
    assert.notEqual(status, 0, output);
    assert.match(output, /DATABASE_URL/);
    assert.doesNotMatch(output, /5433|testdb|ECONNREFUSED/);
  });

  it('names the database it introspects, with the password masked', () => {
    const { status, output } = runGenerateSchema(dir, ['--url', 'postgres://app:s3cret@127.0.0.1:1/shop']);
    assert.notEqual(status, 0, output);
    assert.match(output, /postgres:\/\/app:\*\*\*@127\.0\.0\.1:1\/shop/);
    assert.doesNotMatch(output, /s3cret/);
  });
});
