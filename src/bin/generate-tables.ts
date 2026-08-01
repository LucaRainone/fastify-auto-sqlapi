#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../lib/cli/config.js';
import { parseSchemaFile, generateSingleTableFile, generateDbTablesIndex } from '../lib/cli/tables-codegen.js';
import type { ParsedSchema } from '../lib/cli/tables-codegen.js';
import { loadEnvFile, CONSOLE_COLORS, display, displayAsTableRow, error, parseArgs, runCli } from './utils.js';

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
  display('dbTables.ts is created if missing, indexing the Table*.ts files present on disk.', CONSOLE_COLORS.magenta);
}

const tableVarOf = (schema: ParsedSchema): string =>
  'Table' + schema.schemaName.replace(/^Schema/, '');

/** Parse every Schema*.ts on disk — relation detection needs them all, even for a subset run. */
function parseAllSchemas(schemasDir: string, schemaFiles: string[]): ParsedSchema[] {
  const parsed: ParsedSchema[] = [];
  for (const file of schemaFiles) {
    const content = fs.readFileSync(path.join(schemasDir, file), 'utf-8');
    const schema = parseSchemaFile(content);
    if (schema) parsed.push(schema);
  }
  return parsed;
}

/** The schemas to emit Table files for. Exits when a requested name has no schema. */
function selectTargetSchemas(
  allSchemas: ParsedSchema[],
  all: boolean,
  requested: string[]
): ParsedSchema[] {
  if (all) return allSchemas;

  const requestedSet = new Set(requested);
  const targets = allSchemas.filter((s) => requestedSet.has(s.tableName));
  const foundNames = new Set(targets.map((s) => s.tableName));

  for (const name of requestedSet) {
    if (!foundNames.has(name)) {
      error(`Table "${name}" not found. Available: ${allSchemas.map((s) => s.tableName).join(', ')}`);
      process.exit(1);
    }
  }
  return targets;
}

/** Write the missing Table*.ts files. Existing ones are never overwritten. */
function writeTableFiles(
  targetSchemas: ParsedSchema[],
  allSchemas: ParsedSchema[],
  tablesDir: string
): string[] {
  const created: string[] = [];

  for (const schema of targetSchemas) {
    const tableVarName = tableVarOf(schema);
    const tableFile = path.join(tablesDir, `${tableVarName}.ts`);

    if (fs.existsSync(tableFile)) {
      displayAsTableRow(`${tableVarName}.ts`, 'skipped (already exists)', 60, CONSOLE_COLORS.gray);
      continue;
    }

    fs.writeFileSync(tableFile, generateSingleTableFile(schema, allSchemas));
    created.push(tableVarName);
    displayAsTableRow(`${tableVarName}.ts`, 'created', 60, CONSOLE_COLORS.green);
  }

  return created;
}

/**
 * Write `dbTables.ts` only when missing. The index must reference only the Table*.ts files
 * actually on disk: a subset run would otherwise emit imports for files never generated,
 * and the consumer's project would not compile. When it already exists, the newly created
 * tables are reported instead of being silently left out.
 */
function writeDbTablesIndex(
  tablesDir: string,
  allSchemas: ParsedSchema[],
  createdTableVars: string[]
): void {
  const dbTablesFile = path.join(tablesDir, 'dbTables.ts');

  if (!fs.existsSync(dbTablesFile)) {
    const existingTableVars = new Set(
      fs
        .readdirSync(tablesDir)
        .filter((f) => f.startsWith('Table') && f.endsWith('.ts'))
        .map((f) => f.slice(0, -'.ts'.length))
    );
    const indexSchemas = allSchemas.filter((s) => existingTableVars.has(tableVarOf(s)));
    fs.writeFileSync(dbTablesFile, generateDbTablesIndex(indexSchemas));
    displayAsTableRow('dbTables.ts', 'created', 60, CONSOLE_COLORS.green);
    return;
  }

  displayAsTableRow('dbTables.ts', 'skipped (already exists)', 60, CONSOLE_COLORS.gray);
  const indexContent = fs.readFileSync(dbTablesFile, 'utf-8');
  const missing = createdTableVars.filter((v) => !indexContent.includes(v));
  if (missing.length > 0) {
    display(
      `Remember to add the new tables to dbTables.ts: ${missing.join(', ')}`,
      CONSOLE_COLORS.yellow
    );
  }
}

await runCli('fastify-auto-sqlapi: generating tables template', async () => {
  const cliArgs = parseArgs({
    output: { type: 'value' },
    all:    { type: 'flag'  },
    tables: { type: 'list'  },
  });

  if (!cliArgs.all && cliArgs.tables.length === 0) {
    printHelp();
    process.exit(1);
  }

  const config = await loadConfig();
  loadEnvFile(config.envFile);
  const outputDir = path.resolve(process.cwd(), cliArgs.output || config.outputDir);
  const schemasDir = path.join(outputDir, 'schemas');
  const tablesDir = path.join(outputDir, 'tables');

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

  const allSchemas = parseAllSchemas(schemasDir, schemaFiles);
  if (allSchemas.length === 0) {
    error('No valid schemas parsed.');
    process.exit(1);
  }

  const targetSchemas = selectTargetSchemas(allSchemas, cliArgs.all, cliArgs.tables);
  const createdTableVars = writeTableFiles(targetSchemas, allSchemas, tablesDir);
  writeDbTablesIndex(tablesDir, allSchemas, createdTableVars);

  console.log('');
  display(
    'Edit the generated Table*.ts files to customize your table configuration.',
    CONSOLE_COLORS.magenta
  );
});
