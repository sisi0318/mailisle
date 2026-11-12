import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';
import { getBuildInfo } from '../../scripts/build-info';

export default defineConfig({
  entry: ['apps/server/src/index.ts', 'apps/server/src/password.ts'], outDir: 'apps/server/dist', format: ['esm'], platform: 'node',
  target: 'node22', sourcemap: true, clean: true, noExternal: [/^@mail\//],
  define: { __MAILISLE_BUILD__: JSON.stringify(getBuildInfo()) },
  external: ['better-sqlite3', 'drizzle-orm', 'imapflow', 'nodemailer', 'postal-mime', 'socks', 'zod', 'hono', '@hono/node-server', 'html-to-text', 'fast-xml-parser', 'proxy-agent'],
  onSuccess: async () => {
    await cp('packages/db/migrations', 'apps/server/dist/migrations', { recursive: true });
    await cp('docs', 'apps/server/dist/docs', { recursive: true });
  },
});
