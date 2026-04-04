#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../lib/cli/config.js';
import { buildConnectionString, introspectTables } from '../lib/cli/pg-introspect.js';
import { buildMysqlConnectionConfig, introspectMysqlTables } from '../lib/cli/mysql-introspect.js';
import { buildTableMap, generateSchemaFile } from '../lib/cli/schema-codegen.js';
import { loadEnvFile, CONSOLE_COLORS, display, displayAsTableRow, error } from './utils.js';
import type { ColumnInfo, DialectName } from '../types.js';

loadEnvFile();

function parseCliArgs(): { output?: string; tables?: string[]; dialect?: string } {
  const args = process.argv.slice(2);
  const result: { output?: string; tables?: string[]; dialect?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      result.output = args[++i];
    } else if (args[i] === '--tables' && i + 1 < args.length) {
      result.tables = args[++i].split(',').map((t) => t.trim()).filter(Boolean);
    } else if (args[i] === '--dialect' && i + 1 < args.length) {
      result.dialect = args[++i];
    }
  }
  return result;
}

async function main(): Promise<void> {
  display(
    '++++++ fastify-auto-sqlapi: generating schemas ++++++',
    CONSOLE_COLORS.yellow
  );

  const cliArgs = parseCliArgs();
  const config = await loadConfig();
  const dialect = (cliArgs.dialect || config.dialect || 'postgres') as DialectName;
  const schema = config.schema || (dialect === 'postgres' ? 'public' : config.schema || 'public');
  const outputDir = path.resolve(process.cwd(), cliArgs.output || config.outputDir);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    display(`Created directory: ${outputDir}`, CONSOLE_COLORS.green);
  }

  let rows: ColumnInfo[];
  if (dialect === 'mysql' || dialect === 'mariadb') {
    const connConfig = buildMysqlConnectionConfig();
    rows = await introspectMysqlTables(connConfig, connConfig.database);
  } else {
    const connectionString = buildConnectionString();
    rows = await introspectTables(connectionString, schema);
  }

  if (rows.length === 0) {
    display(
      `No tables found in schema "${schema}".`,
      CONSOLE_COLORS.magenta
    );
    return;
  }

  const tableMap = buildTableMap(rows);

  // Filter tables if --tables flag is provided
  const tableNames = cliArgs.tables;
  if (tableNames) {
    for (const schemaName of Object.keys(tableMap)) {
      if (!tableNames.includes(tableMap[schemaName].name)) {
        delete tableMap[schemaName];
      }
    }
    if (Object.keys(tableMap).length === 0) {
      display(
        `No matching tables found for: ${tableNames.join(', ')}`,
        CONSOLE_COLORS.magenta
      );
      return;
    }
  }

  let somethingCreated = false;
  let somethingTouched = false;
  let untouched = 0;
  const generatedFiles = new Set<string>();

  for (const schemaName of Object.keys(tableMap)) {
    const { name: tableName, fields } = tableMap[schemaName];
    const filename = path.join(outputDir, `${schemaName}.ts`);
    generatedFiles.add(`${schemaName}.ts`);

    const content = generateSchemaFile(schemaName, tableName, fields);

    let status = 'created';
    let color: number = CONSOLE_COLORS.green;

    if (fs.existsSync(filename)) {
      status = 'untouched';
      color = CONSOLE_COLORS.gray;
      if (fs.readFileSync(filename, 'utf-8') !== content) {
        status = 'updated';
        color = CONSOLE_COLORS.cyan;
      }
    } else {
      somethingCreated = true;
    }

    if (status !== 'untouched') {
      fs.writeFileSync(filename, content);
      displayAsTableRow(filename, status, 90, color);
      somethingTouched = true;
    } else {
      untouched++;
    }
  }

  // Remove orphan Schema*.ts files (only when generating all tables)
  if (!tableNames) {
    const existingFiles = fs.readdirSync(outputDir);
    for (const file of existingFiles) {
      if (file.startsWith('Schema') && file.endsWith('.ts') && !generatedFiles.has(file)) {
        const filePath = path.join(outputDir, file);
        fs.unlinkSync(filePath);
        displayAsTableRow(filePath, 'removed', 90, CONSOLE_COLORS.red);
        somethingTouched = true;
      }
    }
  }

  console.log('');
  if (untouched > 0) {
    display(`${untouched} schema(s) untouched`, CONSOLE_COLORS.gray);
  }
  if (somethingCreated) {
    display(
      "Don't forget to git add your new Schema files.",
      CONSOLE_COLORS.magenta
    );
  }
  if (!somethingTouched) {
    display('All schemas are already up to date.', CONSOLE_COLORS.magenta);
  }
}

main().catch((e) => {
  error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
