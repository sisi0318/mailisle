import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { MailStore } from '@mail/db';
import { BodyCache, deriveKey, hashPassword, MailService, UploadStore, Vault } from '@mail/core';
import { createApp } from './app';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = readConfig();
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
    dev: config.dev, webRoot: resolve('apps/web/dist'), docsRoot: existsSync(join(entryDir, 'docs')) ? join(entryDir, 'docs') : resolve('docs') });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () => {
    console.log(`信屿 MailIsle 已启动：http://127.0.0.1:${config.port}`);
    service.start();
  });
  const shutdown = async () => { server.close(); await service.stop(); store.close(); process.exit(0); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; void service.stop().then(() => store.close()); });
}

function readConfig() {
  const password = process.env.MAIL_MASTER_PASSWORD;
  if (!password || password.length < 12) throw new Error('请在 .env 或环境变量中设置至少 12 个字符的 MAIL_MASTER_PASSWORD；它同时是首次登录密码');
  const port = Number(process.env.MAIL_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MAIL_PORT 必须为 1–65535 的整数');
  if (process.env.MAIL_HOST && process.env.MAIL_HOST !== '127.0.0.1') throw new Error('当前阶段仅支持监听 127.0.0.1，远程访问将在后续阶段开放');
  return { password, port, dataDir: resolve(process.env.MAIL_DATA_DIR ?? '.data'), dev: process.argv.includes('--dev') };
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
