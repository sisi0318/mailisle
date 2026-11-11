import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Suites share GreenMail accounts; full-account sync must not race another suite's folder cleanup.
  test: { include: ['packages/*/src/**/*.integration.test.ts'], fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 },
});
