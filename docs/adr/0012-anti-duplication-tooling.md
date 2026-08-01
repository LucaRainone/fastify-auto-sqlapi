# 0012. Repository rules are enforced by executable gates, not by documentation

- **Status**: accepted
- **Date**: 2026-08-01

## Context

Every session starts with an empty context window. An agent that cannot find existing code
rewrites it, invents a second name for an existing concept, and scatters logic across the
tree. Documentation does not prevent this: it is only read when someone remembers to read
it, and `CLAUDE.md` is weighted context, not configuration.

The repository had no ESLint, no Prettier, no git hooks and no CI beyond publish-on-tag.
Measured starting point: 2.50% duplicated lines (3.27% of tokens, 18 clones), naming drift
effectively zero, layering already clean, and `fastify-plugin` imported but absent from
`package.json` — a real packaging bug that no human review had caught.

## Decision

Anything that must not happen is a hook or a lint rule. Prose is reserved for what cannot
be executed.

Gates are **silent and zero-tolerance by default**; pre-existing debt is switched off and
surfaced by `npm run debt` (`lint:strict`, `dup:strict`, `depcruise:strict`,
`knip:strict`). npm scripts are the source of truth — git hooks only call them — so any
gate can be run without touching git history.

Rejected the ratchet-on-a-warning-count approach that was tried first: a run that always
prints 241 warnings trains everyone to ignore its output, and the number drifts upward
unnoticed. A rule is either enforced or explicitly deferred, never "warned about".

## Alternatives considered

- **Baseline thresholds with warnings** (`--max-warnings 241`) — rejected after
  implementing it: noisy output is ignored output, and the boundary is invisible.
- **Barrel enforcement via `no-restricted-imports`** — rejected: the repo has one barrel,
  `src/index.ts`, which is the npm surface. Blocking deep imports would break every
  internal import and require restructuring into per-module barrels. `dependency-cruiser`
  encodes the same boundaries without moving a single file.
- **Intent tags with a closed vocabulary, and `cspell`** — rejected: 64 files, coherent
  naming, one maintainer. A half-maintained tag system is worse than none, and spellchecking
  a 951-line README full of SQL identifiers is pure noise.
- **Session worklog** — rejected: without a compaction ritual nobody will run, an
  append-only log becomes context noise within weeks.

## Consequences

- New violations fail immediately; the deferred list in `eslint.config.js` is the debt
  ledger and may only shrink.
- `docs/INDEX.md` is generated and CI fails when it is stale, like a lockfile. It is
  excluded from the npm package: publishing 204 internal declarations would invite
  consumers to import what is not public API.
- Type-only import cycles through `src/types.ts` are deferred, not fixed. Verified they
  are erased on emit — the compiled `dist/` graph has zero cycles.
- 16 exports are used only inside their own file and should lose the `export` keyword.
  Until then `knip` cannot check exports by default.
- Maintainer scripts require Node ≥22.18 (native TypeScript type stripping). The published
  package still supports Node ≥18.
