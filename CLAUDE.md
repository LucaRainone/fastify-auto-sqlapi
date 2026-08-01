# Contributing to fastify-auto-sqlapi

Rules for working **on** this library. To learn how to **use** it, read
[AGENTS.md](./AGENTS.md) — it is the consumer-facing entry point and is not repeated here.

@docs/GLOSSARY.md

## Non-negotiable

- **Never commit, push, merge, rebase or tag.** Committing is the human's review checkpoint:
  it is how new files and diffs get seen. Run `npm run verify`, report the result, stop.
  `git add` is fine. (Enforced by a `PreToolUse` hook, not by this sentence.)
- **All file content in English** — code, comments, log messages, docs, script output —
  regardless of the language used in chat.
- **Tests are the specification.** If a test fails after a change, the code is wrong. Never
  edit a test to make code pass unless asked. Test names describe capabilities in domain
  vocabulary, which makes `grep` over them a capability index CI keeps honest.

## Before writing a new file under `src/`

1. `npm run find-similar -- "<what I am about to build>"`
2. Read [docs/INDEX.md](./docs/INDEX.md) for the target module
3. Something close exists → extend or generalise it, do not fork it
4. Nothing exists → create it in the right module
5. State which existing module you evaluated and why it does not fit

A hook blocks new files under `src/` until step 1 has run. Naming: use the terms in
`docs/GLOSSARY.md`; a second name for an existing concept breaks search and gets the
concept built twice.

## Commands

| | |
|---|---|
| `npm run check` | eslint + tsc — seconds, run it often |
| `npm run verify` | full gate: check, build, index, dup, depcruise, knip, unit tests |
| `npm run debt` | what is deliberately deferred, with counts |
| `npm run find-similar -- "…"` | does this already exist? |
| `npm run index` | regenerate `docs/INDEX.md` (CI fails if stale) |
| `npm run test:integration` | needs Docker: `npm run test:setup` first |

## Conventions that differ from tool defaults

- Gates are **silent by default and zero-tolerance**. Known debt is switched off, not
  demoted to a warning, and shown by `npm run debt`. Shrink that list; never add to it to
  silence a fresh violation. See [ADR 0012](./docs/adr/0012-anti-duplication-tooling.md).
- Tests are `.js` importing from `dist/`, so **`npm run build` before running them** —
  `verify` does this for you. Integration tests are not in CI.
- Architectural boundaries are enforced by `.dependency-cruiser.mjs`, not by convention:
  `lib/` never imports `routes/`, engines never import a driver adapter, `types/` is a leaf.
- Deliberate design decisions live in [docs/adr/](./docs/adr/README.md). Read before
  "fixing" open-by-default, non-transactional bulk, or raw DB errors — they are decisions.
