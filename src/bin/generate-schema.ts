#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../lib/cli/config.js';
import { buildConnectionString, introspectTables } from '../lib/cli/pg-introspect.js';
import { buildMysqlConnectionConfig, introspectMysqlTables } from '../lib/cli/mysql-introspect.js';
import { buildTableMap, generateSchemaFile } from '../lib/cli/schema-codegen.js';
import { loadEnvFile, CONSOLE_COLORS, display, displayAsTableRow, parseArgs, runCli } from './utils.js';
import type { ColumnInfo, DialectName } from '../types.js';

await runCli('fastify-auto-sqlapi: generating schemas', async () => {
  const cliArgs = parseArgs({
    output:  { type: 'value' },
    tables:  { type: 'list'  },
    dialect: { type: 'value' },
  });
  const config = await loadConfig();
  loadEnvFile(config.envFile);
  const dialect = (cliArgs.dialect || config.dialect || 'postgres') as DialectName;
  const schema = config.schema || (dialect === 'postgres' ? 'public' : config.schema || 'public');
  const outputDir = path.resolve(process.cwd(), cliArgs.output || config.outputDir);
  const schemasDir = path.join(outputDir, 'schemas');

  if (!fs.existsSync(schemasDir)) {
    fs.mkdirSync(schemasDir, { recursive: true });
    display(`Created directory: ${schemasDir}`, CONSOLE_COLORS.green);
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
  if (tableNames.length) {
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
    const { name: tableName, fields, colMap } = tableMap[schemaName];
    const filename = path.join(schemasDir, `${schemaName}.ts`);
    generatedFiles.add(`${schemaName}.ts`);

    const content = generateSchemaFile(schemaName, tableName, fields, colMap);

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
  if (!tableNames.length) {
    const existingFiles = fs.readdirSync(schemasDir);
    for (const file of existingFiles) {
      if (file.startsWith('Schema') && file.endsWith('.ts') && !generatedFiles.has(file)) {
        const filePath = path.join(schemasDir, file);
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
});
