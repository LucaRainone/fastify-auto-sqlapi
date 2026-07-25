import type { FastifyInstance } from 'fastify';
import { buildAgentManifest, renderAgentManifestMd } from '../../lib/agent/manifest.js';
import type { SqlApiPluginOptions } from '../../types.js';

/**
 * GET /agent/manifest      → JSON description of every exposed table
 * GET /agent/manifest.md   → compact markdown for an LLM system prompt
 *
 * Opt-in via the `agentManifest` plugin option (like `swagger`). Runs behind the same
 * global `onRequests` hooks as the data routes. The manifest is built once at startup —
 * `DbTables` is static configuration.
 */
export default async function agentManifestRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  const manifest = buildAgentManifest(options.DbTables);
  const markdown = renderAgentManifestMd(manifest);
  const onRequest = options.onRequests?.length ? options.onRequests : undefined;

  fastify.get('/agent/manifest', {
    ...(onRequest ? { onRequest } : {}),
    schema: {
      tags: ['SqlAPI-agent'],
      summary: 'Agent manifest (JSON)',
      description: 'Machine-readable description of every exposed table: fields, operations, join aliases, computed fields. Pair with AGENT_CLIENT.md.',
    },
  }, async () => manifest);

  fastify.get('/agent/manifest.md', {
    ...(onRequest ? { onRequest } : {}),
    schema: {
      tags: ['SqlAPI-agent'],
      summary: 'Agent manifest (markdown)',
      description: 'Compact markdown rendering of the manifest, designed for an LLM system prompt.',
    },
  }, async (_req, reply) => reply.type('text/markdown; charset=utf-8').send(markdown));
}
