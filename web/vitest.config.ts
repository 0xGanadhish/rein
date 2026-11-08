import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next compiles JSX itself (tsconfig says preserve); tests need it compiled here.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { environment: 'node', include: ['**/*.test.{ts,tsx}'], exclude: ['node_modules/**', 'e2e/**'] },
});
