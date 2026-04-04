#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../lib/cli/config.js';
import { parseSchemaFile, generateSingleTableFile, generateDbTablesIndex } from '../lib/cli/tables-codegen.js';
import type { ParsedSchema } from '../lib/cli/tables-codegen.js';
import { loadEnvFile, CONSOLE_COLORS, display, displayAsTableRow, error } from './utils.js';

loadEnvFile();

function printHelp(): void {
  console.log('');
  display('Usage:', CONSOLE_COLORS.yellow);
  console.log('  sqlapi-generate-tables <table1> [table2 ...]   Generate specific tables (comma or space separated)');
  console.log('  sqlapi-generate-tables --all                   Generate all tables');
  console.log('');
  display('Options:', CONSOLE_COLORS.yellow);
  console.log('  --all                Generate Table*.ts for all schemas found');
  console.log('  --output <dir>       Output directory (default: from sqlapi.config)');
  console.log('');
  display('Examples:', CONSOLE_COLORS.yellow);
  console.log('  sqlapi-generate-tables customer customer_order');
  console.log('  sqlapi-generate-tables customer,customer_order');
  console.log('  sqlapi-generate-tables --all');
  console.log('');
  display('Table*.ts files are only created if they do not already exist.', CONSOLE_COLORS.magenta);
  display('dbTables.ts is always regenerated to include all schemas.', CONSOLE_COLORS.magenta);
}

function parseCliArgs(): { output?: string; all: boolean; tables: string[] } {
  const args = process.argv.slice(2);
  const result: { output?: string; all: boolean; tables: string[] } = { all: false, tables: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      result.output = args[++i];
    } else if (args[i] === '--all') {
      result.all = true;
    } else if (!args[i].startsWith('--')) {
      // Split by comma to support both "a b" and "a,b" and "a, b"
      for (const part of args[i].split(',')) {
        const trimmed = part.trim();
        if (trimmed) result.tables.push(trimmed);
      }
    }
  }
  return result;
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();

  if (!cliArgs.all && cliArgs.tables.length === 0) {
    display(
      '++++++ fastify-auto-sqlapi: generate tables template ++++++',
      CONSOLE_COLORS.yellow
    );
    printHelp();
    process.exit(1);
  }

  display(
    '++++++ fastify-auto-sqlapi: generating tables template ++++++',
    CONSOLE_COLORS.yellow
  );

  const config = await loadConfig();
  const outputDir = path.resolve(process.cwd(), cliArgs.output || config.outputDir);
  const schemasDir = outputDir;
  const tablesDir = outputDir;

  if (!fs.existsSync(schemasDir)) {
    error(`Schemas directory not found: ${schemasDir}`);
    display('Run sqlapi-generate-schema first.', CONSOLE_COLORS.magenta);
    process.exit(1);
  }

  if (!fs.existsSync(tablesDir)) {
    fs.mkdirSync(tablesDir, { recursive: true });
    display(`Created directory: ${tablesDir}`, CONSOLE_COLORS.green);
  }

  const schemaFiles = fs
    .readdirSync(schemasDir)
    .filter((f) => f.startsWith('Schema') && f.endsWith('.ts'))
    .sort();

  if (schemaFiles.length === 0) {
    error('No Schema*.ts files found.');
    display('Run sqlapi-generate-schema first.', CONSOLE_COLORS.magenta);
    process.exit(1);
  }

  // Parse all schemas (needed for relation detection even when generating a subset)
  const allSchemas: ParsedSchema[] = [];
  for (const file of schemaFiles) {
    const content = fs.readFileSync(path.join(schemasDir, file), 'utf-8');
    const parsed = parseSchemaFile(content);
    if (parsed) {
      allSchemas.push(parsed);
    }
  }

  if (allSchemas.length === 0) {
    error('No valid schemas parsed.');
    process.exit(1);
  }

  // Determine which schemas to generate Table files for
  let targetSchemas: ParsedSchema[];
  if (cliArgs.all) {
    targetSchemas = allSchemas;
  } else {
    const requestedSet = new Set(cliArgs.tables);
    targetSchemas = allSchemas.filter((s) => requestedSet.has(s.tableName));

    const foundNames = new Set(targetSchemas.map((s) => s.tableName));
    for (const name of requestedSet) {
      if (!foundNames.has(name)) {
        error(`Table "${name}" not found. Available: ${allSchemas.map((s) => s.tableName).join(', ')}`);
        process.exit(1);
      }
    }
  }

  // Generate individual Table*.ts files (skip if already exists)
  for (const schema of targetSchemas) {
    const tableVarName = 'Table' + schema.schemaName.replace(/^Schema/, '');
    const tableFile = path.join(tablesDir, `${tableVarName}.ts`);

    if (fs.existsSync(tableFile)) {
      displayAsTableRow(`${tableVarName}.ts`, 'skipped (already exists)', 60, CONSOLE_COLORS.gray);
    } else {
      const content = generateSingleTableFile(schema, allSchemas);
      fs.writeFileSync(tableFile, content);
      displayAsTableRow(`${tableVarName}.ts`, 'created', 60, CONSOLE_COLORS.green);
    }
  }

  // Generate dbTables.ts only if it does not exist
  const dbTablesFile = path.join(tablesDir, 'dbTables.ts');
  if (fs.existsSync(dbTablesFile)) {
    displayAsTableRow('dbTables.ts', 'skipped (already exists)', 60, CONSOLE_COLORS.gray);
  } else {
    const dbTablesContent = generateDbTablesIndex(allSchemas);
    fs.writeFileSync(dbTablesFile, dbTablesContent);
    displayAsTableRow('dbTables.ts', 'created', 60, CONSOLE_COLORS.green);
  }

  console.log('');
  display(
    'Edit the generated Table*.ts files to customize your table configuration.',
    CONSOLE_COLORS.magenta
  );
}

main().catch((e) => {
  error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
