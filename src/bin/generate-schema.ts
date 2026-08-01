#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../lib/cli/config.js';
import { buildConnectionString, introspectTables } from '../lib/cli/pg-introspect.js';
import { buildMysqlConnectionConfig, introspectMysqlTables } from '../lib/cli/mysql-introspect.js';
import { applyExcludeTables, buildTableMap, generateSchemaFile } from '../lib/cli/schema-codegen.js';
import { loadEnvFile, CONSOLE_COLORS, display, displayAsTableRow, parseArgs, runCli } from './utils.js';
import type { ColumnInfo, DialectName, TableMap } from '../types.js';

// Helpers are declared before the top-level `await runCli(...)` below: that call runs
// immediately, so anything it reaches must already be initialised.

type FileStatus = 'created' | 'updated' | 'untouched';

const STATUS_COLOR: Record<FileStatus, number> = {
  created: CONSOLE_COLORS.green,
  updated: CONSOLE_COLORS.cyan,
  untouched: CONSOLE_COLORS.gray,
};

interface WriteReport {
  /** At least one file did not exist before — worth telling the user to `git add`. */
  created: boolean;
  /** At least one file was written or removed. */
  touched: boolean;
  untouched: number;
  files: Set<string>;
}

function introspect(dialect: DialectName, schema: string): Promise<ColumnInfo[]> {
  if (dialect === 'mysql' || dialect === 'mariadb') {
    const connConfig = buildMysqlConnectionConfig();
    return introspectMysqlTables(connConfig, connConfig.database);
  }
  return introspectTables(buildConnectionString(), schema);
}

/** Narrow the map to the `--tables` selection. Returns false when nothing matched. */
function keepOnlyRequestedTables(tableMap: TableMap, tableNames: string[]): boolean {
  if (!tableNames.length) return true;
  for (const schemaName of Object.keys(tableMap)) {
    if (!tableNames.includes(tableMap[schemaName].name)) {
      delete tableMap[schemaName];
    }
  }
  return Object.keys(tableMap).length > 0;
}

function fileStatus(filename: string, content: string): FileStatus {
  if (!fs.existsSync(filename)) return 'created';
  return fs.readFileSync(filename, 'utf-8') === content ? 'untouched' : 'updated';
}

function writeSchemaFiles(tableMap: TableMap, schemasDir: string): WriteReport {
  const report: WriteReport = { created: false, touched: false, untouched: 0, files: new Set() };

  for (const schemaName of Object.keys(tableMap)) {
    const { name: tableName, fields, colMap, primary } = tableMap[schemaName];
    const filename = path.join(schemasDir, `${schemaName}.ts`);
    report.files.add(`${schemaName}.ts`);

    const content = generateSchemaFile(schemaName, tableName, fields, colMap, primary);
    const status = fileStatus(filename, content);

    if (status === 'created') report.created = true;
    if (status === 'untouched') {
      report.untouched++;
      continue;
    }

    fs.writeFileSync(filename, content);
    displayAsTableRow(filename, status, 90, STATUS_COLOR[status]);
    report.touched = true;
  }

  return report;
}

/**
 * Delete `Schema*.ts` files no longer backed by a table — including the ones whose table
 * was just excluded by config. Only safe when generating every table: with `--tables` the
 * unlisted schemas are legitimately absent from `generated`.
 */
function removeOrphanSchemas(schemasDir: string, generated: Set<string>): boolean {
  let removed = false;
  for (const file of fs.readdirSync(schemasDir)) {
    if (file.startsWith('Schema') && file.endsWith('.ts') && !generated.has(file)) {
      const filePath = path.join(schemasDir, file);
      fs.unlinkSync(filePath);
      displayAsTableRow(filePath, 'removed', 90, CONSOLE_COLORS.red);
      removed = true;
    }
  }
  return removed;
}

function reportOutcome(report: WriteReport): void {
  console.log('');
  if (report.untouched > 0) {
    display(`${report.untouched} schema(s) untouched`, CONSOLE_COLORS.gray);
  }
  if (report.created) {
    display("Don't forget to git add your new Schema files.", CONSOLE_COLORS.magenta);
  }
  if (!report.touched) {
    display('All schemas are already up to date.', CONSOLE_COLORS.magenta);
  }
}

await runCli('fastify-auto-sqlapi: generating schemas', async () => {
  const cliArgs = parseArgs({
    output:  { type: 'value' },
    tables:  { type: 'list'  },
    dialect: { type: 'value' },
  });
  const config = await loadConfig();
  loadEnvFile(config.envFile);
  const dialect = (cliArgs.dialect || config.dialect || 'postgres') as DialectName;
  const schema = config.schema || 'public';
  const outputDir = path.resolve(process.cwd(), cliArgs.output || config.outputDir);
  const schemasDir = path.join(outputDir, 'schemas');

  if (!fs.existsSync(schemasDir)) {
    fs.mkdirSync(schemasDir, { recursive: true });
    display(`Created directory: ${schemasDir}`, CONSOLE_COLORS.green);
  }

  const rows = await introspect(dialect, schema);
  if (rows.length === 0) {
    display(`No tables found in schema "${schema}".`, CONSOLE_COLORS.magenta);
    return;
  }

  const tableMap = buildTableMap(rows);

  // Config blacklist: excluded tables are invisible to the generator, so their schema files
  // (if any) fall through to the orphan cleanup below. Deliberately no early return when
  // everything is excluded — that cleanup still has to run.
  const excluded = applyExcludeTables(tableMap, config.excludeTables);
  if (excluded.length) {
    display(`Excluded by config (excludeTables): ${excluded.join(', ')}`, CONSOLE_COLORS.gray);
  }

  const tableNames = cliArgs.tables;
  if (!keepOnlyRequestedTables(tableMap, tableNames)) {
    display(`No matching tables found for: ${tableNames.join(', ')}`, CONSOLE_COLORS.magenta);
    return;
  }

  const report = writeSchemaFiles(tableMap, schemasDir);
  if (!tableNames.length && removeOrphanSchemas(schemasDir, report.files)) {
    report.touched = true;
  }

  reportOutcome(report);
});
