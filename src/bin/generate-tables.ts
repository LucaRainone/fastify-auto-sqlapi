#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../lib/cli/config.js';
import { parseSchemaFile, generateTablesFile } from '../lib/cli/tables-codegen.js';
import type { ParsedSchema } from '../lib/cli/tables-codegen.js';
import { CONSOLE_COLORS, display, displayAsTableRow, error } from './utils.js';

async function main(): Promise<void> {
  display(
    '++++++ fastify-auto-sqlapi: generating tables template ++++++',
    CONSOLE_COLORS.yellow
  );

  const config = await loadConfig();
  const outputDir = path.resolve(process.cwd(), config.outputDir);

  if (!fs.existsSync(outputDir)) {
    error(`Output directory not found: ${outputDir}`);
    display('Run sqlapi-generate-schema first.', CONSOLE_COLORS.magenta);
    process.exit(1);
  }

  const schemaFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith('Schema') && f.endsWith('.ts'))
    .sort();

  if (schemaFiles.length === 0) {
    error('No Schema*.ts files found.');
    display('Run sqlapi-generate-schema first.', CONSOLE_COLORS.magenta);
    process.exit(1);
  }

  const schemas: ParsedSchema[] = [];
  for (const file of schemaFiles) {
    const content = fs.readFileSync(path.join(outputDir, file), 'utf-8');
    const parsed = parseSchemaFile(content);
    if (parsed) {
      schemas.push(parsed);
      displayAsTableRow(file, `${parsed.fields.length} fields`, 60, CONSOLE_COLORS.green);
    } else {
      displayAsTableRow(file, 'skipped (parse error)', 60, CONSOLE_COLORS.red);
    }
  }

  if (schemas.length === 0) {
    error('No valid schemas parsed.');
    process.exit(1);
  }

  const outputFile = path.join(outputDir, 'tables.ts');
  const force = process.argv.includes('--force');

  if (fs.existsSync(outputFile) && !force) {
    console.log('');
    error(`${outputFile} already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  const content = generateTablesFile(schemas);
  fs.writeFileSync(outputFile, content);

  console.log('');
  displayAsTableRow(outputFile, force ? 'overwritten' : 'created', 90, CONSOLE_COLORS.green);
  console.log('');
  display(
    'Edit the generated file to customize your table configuration.',
    CONSOLE_COLORS.magenta
  );
}

main().catch((e) => {
  error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
