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
    'web/next-env.d.ts',
    'web/test-results/',
    'web/playwright-report/',
    '.worktrees/',
    '.git/',
    '.env*',
  ]),
  {
    files: ['worker/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.ts', 'web/**/*.{ts,tsx}', 'mcp/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
  },
]);
