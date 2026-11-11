import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { MailStore } from '@mail/db';
import { BodyCache, deriveKey, hashPassword, MailService, UploadStore, Vault } from '@mail/core';
import { createApp } from './app';
import { readConfig } from './config';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = readConfig();
  const tls = config.tls ? { createServer, serverOptions: { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) } } : {};
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const migrations = existsSync(join(entryDir, 'migrations')) ? join(entryDir, 'migrations') : resolve('packages/db/migrations');
  const store = new MailStore(join(config.dataDir, 'mail.sqlite'), migrations);
  const salt = store.getSetting('vault-salt') ?? randomBytes(32).toString('hex');
  const vault = new Vault(await deriveKey(config.password, salt));
  const check = store.getSetting('vault-check');
  if (check) {
    try { vault.decrypt(check); }
    catch { store.close(); throw new Error('启动口令与已有数据库不匹配，请使用首次启动时的 MAIL_MASTER_PASSWORD'); }
  } else {
    store.setSetting('vault-salt', salt);
    store.setSetting('vault-check', vault.encrypt('mail-v1'));
    store.setSetting('password-hash', await hashPassword(config.password));
  }
  const service = new MailService(store, vault, new BodyCache(join(config.dataDir, 'bodies')), undefined, new UploadStore(store, join(config.dataDir, 'uploads')));
  const app = createApp({ service, passwordHash: store.getSetting('password-hash')!, port: config.port,
    dev: config.dev, publicUrl: config.publicUrl, https: !!config.tls,
    webRoot: resolve('apps/web/dist'), docsRoot: existsSync(join(entryDir, 'docs')) ? join(entryDir, 'docs') : resolve('docs') });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port, ...tls }, () => {
    const localHost = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`信屿 MailIsle 已启动：${config.publicUrl ?? `${config.tls ? 'https' : 'http'}://${localHost}:${config.port}`}（监听 ${config.host}:${config.port}）`);
    service.start();
  });
  const shutdown = async () => { server.close(); await service.stop(); store.close(); process.exit(0); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; void service.stop().then(() => store.close()); });
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
