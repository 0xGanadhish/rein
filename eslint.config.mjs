import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/target/',
    '**/out/',
    '**/cache/',
    '**/dist/',
    '**/build/',
    '**/coverage/',
    '**/.wrangler/',
    '**/.next/',
    '**/*.lock',
    '**/*-lock.*',
    '**/*.tsbuildinfo',
    '**/*.wasm',
    'worker/src/vendor/',
    'near/desk/tests/vectors.json',
    'evm/lib/',
    'evm/broadcast/',
    'graphify-out/',
    'web/',
    '.worktrees/',
    '.git/',
    '.env*',
  ]),
  {
    files: ['worker/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
  },
]);
