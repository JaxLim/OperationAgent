import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from './scripts/import-boundaries.mjs';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '.tools/**', '.cache/**', '.pnpm-store/**', 'experiments/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    plugins: { architecture: { rules: { boundaries } } },
    rules: { 'architecture/boundaries': 'error' },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/integration/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', AbortSignal: 'readonly', fetch: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' } },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
];
