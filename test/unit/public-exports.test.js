// The runtime surface of the package, exactly. Anything else is an internal: the engines, the
// route plugins, the schema builders, the naming helpers, the dialect table, the tenant
// resolution. A name added here is a promise to keep; one missing from the list fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from './_harness.js';

const lib = await import(path.join(ROOT, 'dist/index.js'));

const PUBLIC = [
  // the plugin and the programmatic API
  'fastifyAutoSqlApi', 'createSqlApi', 'SqlApi',
  // table config
  'defineTable', 'buildRelation', 'Nullable', 'Type',
  // hooks
  'httpError', 'TENANT_ADMIN', 'ConditionBuilder', 'Expression',
  // database access
  'QueryClient', 'createQueryClient', 'pgQueryable', 'mysqlQueryable',
  // agent clients
  'agentToolSchemas', 'buildAgentManifest', 'renderAgentManifestMd',
];

describe('public exports', () => {
  it('are exactly the public API', () => {
    assert.deepEqual(Object.keys(lib).sort(), [...PUBLIC].sort());
  });
});
