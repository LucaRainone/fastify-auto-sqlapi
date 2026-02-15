import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { camelcaseObject, snakecaseRecord } = await import(
  path.join(ROOT, 'dist/lib/naming.js')
);

describe('camelcaseObject', () => {
  it('converts snake_case keys to camelCase', () => {
    const result = camelcaseObject({
      first_name: 'Mario',
      last_name: 'Rossi',
      created_at: '2024-01-01',
    });
    assert.deepEqual(result, {
      firstName: 'Mario',
      lastName: 'Rossi',
      createdAt: '2024-01-01',
    });
  });

  it('keeps already camelCase keys', () => {
    const result = camelcaseObject({ id: 1, name: 'test' });
    assert.deepEqual(result, { id: 1, name: 'test' });
  });

  it('handles empty object', () => {
    assert.deepEqual(camelcaseObject({}), {});
  });
});

describe('snakecaseRecord', () => {
  it('converts camelCase keys to snake_case', () => {
    const result = snakecaseRecord({
      firstName: 'Mario',
      lastName: 'Rossi',
      createdAt: '2024-01-01',
    });
    assert.deepEqual(result, {
      first_name: 'Mario',
      last_name: 'Rossi',
      created_at: '2024-01-01',
    });
  });

  it('keeps already snake_case keys', () => {
    const result = snakecaseRecord({ id: 1, name: 'test' });
    assert.deepEqual(result, { id: 1, name: 'test' });
  });

  it('handles empty object', () => {
    assert.deepEqual(snakecaseRecord({}), {});
  });
});
