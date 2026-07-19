// Shared unit-test harness.
//
// The engine is tested against a fake driver, so nothing checks that the SQL it produces
// is actually coherent with the values it binds. This harness closes that gap: every query
// the engine issues is verified for placeholder integrity before it is answered.
//
// The invariant is what catches the misbinding class of bug:
//   - no placeholder may reference a value that was not bound
//   - no bound value may go unreferenced by the SQL
// A query that violates either does not fail at the database — it silently reads or filters
// on the wrong parameter, which is exactly how the computed-field misbinding survived a
// fully green suite.

import { Type } from '@sinclair/typebox';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));

/** Count `?` markers, ignoring the `\?` escape. */
function countMarkers(sql) {
  return (sql.match(/\\\?|\?/g) ?? []).filter((m) => m === '?').length;
}

/**
 * Verify that the SQL and the bound values agree. Returns an error message, or null.
 *
 * Postgres-style (`$n`) queries are checked by index; `?`-style queries by count. A query
 * with neither placeholders nor values is trivially consistent.
 */
export function checkPlaceholderIntegrity(sql, values) {
  const vals = values ?? [];
  const refs = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

  if (refs.length === 0) {
    if (vals.length === 0) return null;
    const markers = countMarkers(sql);
    if (markers !== vals.length) {
      return `SQL has ${markers} '?' placeholder(s) but ${vals.length} value(s) were bound`;
    }
    return null;
  }

  const max = Math.max(...refs);
  if (max > vals.length) {
    return `SQL references $${max} but only ${vals.length} value(s) were bound`;
  }

  const referenced = new Set(refs);
  for (let i = 1; i <= vals.length; i++) {
    if (!referenced.has(i)) {
      return `value $${i} (${JSON.stringify(vals[i - 1])}) is bound but never referenced by the SQL`;
    }
  }
  return null;
}

/**
 * Substitute every `$n` with the value actually bound at that position, so a test can assert
 * what the database really receives instead of pattern-matching the raw SQL string.
 */
export function resolvePlaceholders(call) {
  return call.text.replace(/\$(\d+)/g, (_m, n) => JSON.stringify(call.values?.[Number(n) - 1]));
}

/**
 * Fake pg driver. `responses` are returned in order; exhausted calls yield an empty result.
 *
 * Every query is checked for placeholder integrity and the call rejects on violation, so the
 * failure points at the offending query. Violations are also collected on `.violations` for
 * cases where a caller swallows the error. Pass `{ checkPlaceholders: false }` to opt out.
 */
export function createMockPg(responses = [], opts = {}) {
  const { checkPlaceholders = true } = opts;
  let callIndex = 0;
  const calls = [];
  const violations = [];

  return {
    calls,
    violations,
    query(text, values) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: normalized, values });

      if (checkPlaceholders) {
        const problem = checkPlaceholderIntegrity(normalized, values);
        if (problem) {
          violations.push({ sql: normalized, values, problem });
          return Promise.reject(
            new Error(
              `Placeholder integrity violation: ${problem}\n  SQL: ${normalized}\n  values: ${JSON.stringify(values)}`
            )
          );
        }
      }

      const response = responses[callIndex] || { rows: [], affectedRows: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

/** Minimal SchemaDefinition backed by camelCase → snake_case conversion. */
export function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}
