import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'], exclude: ['**/node_modules/**', '**/*.integration.test.ts'] },
});
