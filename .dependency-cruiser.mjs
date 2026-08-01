/**
 * Architectural boundaries for fastify-auto-sqlapi.
 *
 * Every rule below encodes an invariant that already holds in `src/` — they are guards
 * against regression, not aspirations. See docs/adr/0012-anti-duplication-tooling.md.
 *
 * Layers, from outermost to innermost:
 *   bin/ -> lib/cli/                 build-time codegen, never loaded by the server
 *   routes/ -> lib/engine/ -> lib/   request handling -> operations -> primitives
 *   types/                           leaf: type declarations only
 */
// Known-and-accepted findings are silenced by default and surfaced by
// `npm run depcruise:strict` (DEPCRUISE_STRICT=1), so the default run is zero-tolerance.
const STRICT = process.env.DEPCRUISE_STRICT === '1';
const DEFERRED = STRICT ? 'warn' : 'ignore';

export default {
  forbidden: [
    {
      name: 'no-circular-runtime',
      severity: 'error',
      comment:
        'A runtime import cycle causes partially-initialised modules at load time. Cycles routed through the src/types.ts barrel are excluded: their edges are `import type` and are erased on emit (verified — the compiled dist/ graph has zero cycles). Those are covered by no-circular-types below.',
      from: {},
      to: { circular: true, viaOnly: { pathNot: '^src/types(\\.ts$|/)' } },
    },
    {
      name: 'no-circular-types',
      severity: DEFERRED,
      comment:
        'Type-only cycles through src/types.ts are harmless at runtime but blur the types-are-a-leaf boundary. Pre-existing debt (13), visible under depcruise:strict.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment: 'A module nobody imports is dead code an agent cannot find, so it gets rewritten.',
      from: { orphan: true, pathNot: ['^src/index\\.ts$'] },
      to: {},
    },
    {
      name: 'lib-not-to-routes',
      severity: 'error',
      comment: 'Primitives and engines must not reach back up into the HTTP layer.',
      from: { path: '^src/(lib|types)/' },
      to: { path: '^src/routes/' },
    },
    {
      name: 'runtime-not-to-cli',
      severity: 'error',
      comment: 'lib/cli and bin are build-time codegen; the served runtime must never import them.',
      from: { path: '^src/(routes|lib/engine|lib/schema)/' },
      to: { path: '^src/(lib/cli|bin)/' },
    },
    {
      name: 'types-are-a-leaf',
      severity: 'error',
      comment: 'src/types may reference implementation types, but must not depend on runtime values.',
      from: { path: '^src/types' },
      to: { path: '^src/(lib|routes|bin)/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'engine-not-to-adapters',
      severity: 'error',
      comment: 'Engines talk to the DB through QueryClient/dialect, never to a concrete driver adapter.',
      from: { path: '^src/(lib/engine|lib/schema|routes)/' },
      to: { path: '^src/lib/adapters/' },
    },
    {
      name: 'adapters-are-isolated',
      severity: 'error',
      comment: 'The pg and mysql adapters must never reference each other (see dialect-isolation.test.js).',
      from: { path: '^src/lib/adapters/' },
      to: { path: '^src/lib/adapters/', pathNot: ['$1'] },
    },
    {
      name: 'no-static-optional-peer',
      severity: 'error',
      comment:
        'pg/mysql2/@fastify/* are optional peers: a static import breaks installs that use the other dialect. Load them dynamically.',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-peer', 'npm-no-pkg', 'npm-unknown'], pathNot: ['^@sinclair/typebox', '^node-condition-builder'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '^src/example' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
