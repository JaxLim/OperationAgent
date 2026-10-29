import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from './scripts/import-boundaries.mjs';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '.tools/**', '.cache/**', '.pnpm-store/**', 'experiments/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    plugins: { architecture: { rules: { boundaries } } },
    rules: { 'architecture/boundaries': 'error' },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/integration/**/*.mjs', 'tests/worker-fixture/**/*.mjs', 'tests/installer/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', AbortSignal: 'readonly', fetch: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', TextDecoder: 'readonly' } },
  },
  {
    // The trusted fixture bootstrap is the only Worker-side code with Node globals (ADR-WIN-001 narrow exception).
    files: ['apps/agent-worker/bootstrap/fixture-bootstrap.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
];
