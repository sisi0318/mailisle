import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';

export default defineConfig({
  entry: ['apps/server/src/index.ts'], outDir: 'apps/server/dist', format: ['esm'], platform: 'node',
  target: 'node22', sourcemap: true, clean: true, noExternal: [/^@mail\//],
  external: ['better-sqlite3', 'drizzle-orm', 'imapflow', 'nodemailer', 'postal-mime', 'socks', 'zod', 'hono', '@hono/node-server', 'html-to-text'],
  onSuccess: async () => { await cp('packages/db/migrations', 'apps/server/dist/migrations', { recursive: true }); },
});
