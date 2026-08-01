import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

// Rules with pre-existing violations are demoted to `warn` and gated by the
// `--max-warnings` baseline in `npm run lint` (see docs/adr/0012). They are debt to
// ratchet down, not permission to add more: any new violation raises the count and fails.
// Rules NOT listed here are errors — notably sonarjs/no-identical-functions and
// no-identical-expressions, which are already clean.
const BASELINE_DEBT = {
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  '@typescript-eslint/no-unsafe-argument': 'warn',
  '@typescript-eslint/no-unsafe-call': 'warn',
  '@typescript-eslint/no-unsafe-return': 'warn',
  '@typescript-eslint/no-unsafe-function-type': 'warn',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-base-to-string': 'warn',
  '@typescript-eslint/unbound-method': 'warn',
  '@typescript-eslint/require-await': 'warn',
  'sonarjs/cognitive-complexity': 'warn',
  'sonarjs/no-nested-template-literals': 'warn',
  'sonarjs/no-nested-conditional': 'warn',
  'sonarjs/prefer-regexp-exec': 'warn',
  'sonarjs/different-types-comparison': 'warn',
  'sonarjs/super-linear-regex': 'warn',
  'sonarjs/no-alphabetical-sort': 'warn',
  'sonarjs/use-type-alias': 'warn',
  'sonarjs/no-duplicate-string': 'warn',
};

export default tseslint.config(
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
      ...BASELINE_DEBT,
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
      'no-unused-vars': 'warn',
    },
  },
);
