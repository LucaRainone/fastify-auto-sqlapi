import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

// Rules that still have violations somewhere in the repo (mostly src/, but `no-unused-vars`
// is entirely in test/). The counts below are the debt ledger — refresh them whenever the
// number moves, or the file starts lying about what is left to do.
//
// They are OFF by default so `npm run lint`
// is silent, and ON as errors under `npm run lint:strict` (LINT_STRICT=1) to show what is
// left to clean up. See docs/adr/0012.
//
// The default run is therefore a true zero-tolerance gate: everything it checks must be
// clean, and any new violation of a non-listed rule fails immediately. Shrink this list as
// the debt is paid; never add to it to silence a fresh violation.
const STRICT = process.env.LINT_STRICT === '1';
const DEBT_SEVERITY = STRICT ? 'error' : 'off';

const DEFERRED_RULES = [
  '@typescript-eslint/no-unsafe-assignment', // 34
  '@typescript-eslint/no-unsafe-member-access', // 9
  '@typescript-eslint/no-unsafe-argument', // 32
  '@typescript-eslint/no-unsafe-call', // 5
  '@typescript-eslint/no-unsafe-return', // 1
  '@typescript-eslint/no-unsafe-function-type', // 4
  '@typescript-eslint/no-explicit-any', // 3
  '@typescript-eslint/no-base-to-string', // 1
  '@typescript-eslint/unbound-method', // 3
  '@typescript-eslint/require-await', // 3
  'sonarjs/no-nested-conditional', // 2
  'sonarjs/different-types-comparison', // 3
  'sonarjs/super-linear-regex', // 2
  'sonarjs/no-alphabetical-sort', // 1
  'sonarjs/use-type-alias', // 1
  'sonarjs/no-duplicate-string', // 2
];

const DEBT = Object.fromEntries(DEFERRED_RULES.map((rule) => [rule, DEBT_SEVERITY]));

export default tseslint.config(
  {
    // src/ carries `eslint-disable` comments for rules that are deferred above. Outside
    // strict mode those rules are off, which would report every such comment as unused —
    // noise created by the toggle, not by the code. Only strict mode judges them.
    linterOptions: {
      reportUnusedDisableDirectives: STRICT ? 'error' : 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'test/manual/dist/**',
      'test/manual/output/**',
      'coverage/**',
      '.idea/**',
    ],
  },

  // Library source: type-aware linting + duplication detection.
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      sonarjs.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Not enabled by sonarjs/recommended, but core to catching duplication as it is typed.
      'sonarjs/no-duplicate-string': 'error',
      ...DEBT,
    },
  },

  // Git hooks: plain ESM, outside any tsconfig, so no type-aware rules.
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
  },

  // Tests are the specification: they legitimately repeat literals and structure,
  // so the duplication rules are off here. No type-aware linting (plain .js).
  {
    files: ['test/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-unused-vars': DEBT_SEVERITY, // 8
    },
  },
);
