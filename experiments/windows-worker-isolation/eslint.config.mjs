import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['_build/**', '_runs/**', '_downloads/**', '_tmp/**', 'node_modules/**', 'evidence/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', TextDecoder: 'readonly' } } },
  { files: ['src/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/consistent-type-imports': 'error' } },
];
