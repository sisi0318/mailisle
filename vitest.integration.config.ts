import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['packages/*/src/**/*.integration.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
