# 0008. Agent client interface: static grammar + runtime manifest

- **Status**: accepted
- **Date**: 2026-07-26

## Context

The plugin doubles as the enforcement layer for LLM clients that drive the API at runtime
(a chat agent operating on backoffice data: whatever requests the model invents, tenant
scoping, `readExclude`, `operations` and caps still apply). Such a client needs to be
told how to call the API — but an LLM prompt has different constraints than human
documentation: every line costs tokens on every call, and anything deployment-specific
goes stale the moment the schema changes.

## Decision

The client-facing documentation is split into two halves with different lifecycles:

- **Grammar** — `AGENTS_FRONTEND.md`: HOW to call the API (endpoints, search with the four
  join families, condition methods with params arity, ordering notations, pagination,
  writes, error shapes). Static, identical for every deployment, ~110 dense lines designed
  for a system prompt. It deliberately contains **no tables, fields or aliases**.
- **Vocabulary** — the manifest (`agentManifest: true` → `GET {prefix}/agent/manifest(.md)`,
  or `buildAgentManifest()` programmatically): WHAT this deployment exposes — tables,
  fields with type/required/nullable, enabled operations, join aliases with direction,
  computed fields. Generated from `DbTables` at startup, so it can never drift from the
  running configuration.

Three deliberate properties:

1. **The grammar file replaced the old tutorial-style `AGENTS_FRONTEND.md` under the same
   filename.** The path `node_modules/fastify-auto-sqlapi/AGENTS_FRONTEND.md` is known to
   consumers' coding agents; a new filename would have broken every existing reference for
   zero benefit. Do not rename it.
2. **Density is a feature, not a documentation gap.** The file lives in LLM system
   prompts: jsonc examples with terse end-of-line comments, no rationale, no repetition —
   each concept appears exactly once. Normative rules (what returns 400) belong in it;
   explanations do not. Expanding it with prose and tutorials would revert this decision.
3. **Loose validation with the structured 400 as retry signal is the default strategy**
   for LLM tools; strict per-table JSON-Schema tools are opt-in via `agentToolSchemas()`.
   The plugin's 400 (`fields: [{path, code, message}]`) was designed machine-readable, so
   a loose generic tool self-corrects in one round trip. This is also why the plugin does
   not ship an opinionated MCP/tool layer: it provides the pieces (grammar, manifest,
   schemas), the consumer composes them.

## Alternatives considered

- **One complete document (grammar + tables of a given deployment)** — rejected: the
  deployment-specific half goes stale on every schema change; the manifest endpoint is
  the only source that cannot drift.
- **A new `AGENT_CLIENT.md` alongside the old `AGENTS_FRONTEND.md`** — rejected: near-total
  content overlap, proven drift risk (a fix had to be applied to both files during the
  same session that created the second one), and known-path breakage on removal.
- **Strict JSON-Schema tools as the default** — rejected: the full search schema per
  table is enormous (conditions, four join families, per-alias shapes); across N tables
  it explodes prompt size and degrades model performance. Kept as opt-in for hot tables.

## Consequences

- `AGENTS_FRONTEND.md` serves both coding agents (writing client code) and runtime LLM
  clients; the verbose tutorial content it replaced is covered by the grammar plus
  Swagger.
- Contributions that add tables/fields/examples-with-prose to the grammar file, or rename
  it, should be declined with a pointer to this ADR.
- New request-shape features must update the grammar (a rule line, not a tutorial) and,
  when they touch per-table capabilities, the manifest builder.
