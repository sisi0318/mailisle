import { beforeEach, afterEach, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createApp } from '../../../apps/server/src/app';
import { accountConfig, database } from '../../../tests/fixtures';
import { oauthServer, callbackUrl } from '../../../tests/oauth-server';
import { oauthMailServer } from '../../../tests/oauth-mail-server';
import { MailService } from './service';
import { OAuthManager } from './oauth';
import { ImapAdapter } from './imap';
import { BodyCache } from './cache';
import { Vault, hashPassword } from './crypto';

let store: ReturnType<typeof database>;
let auth: Awaited<ReturnType<typeof oauthServer>>;
let mail: Awaited<ReturnType<typeof oauthMailServer>>;
let service: MailService;
let app: ReturnType<typeof createApp>;
let cookie: string;
const account = { ...accountConfig(),
  imap: { host: 'imap.gmail.com', port: 993, security: 'tls', user: 'alice@gmail.com' },
  smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls', user: 'alice@gmail.com' }, email: 'alice@gmail.com', sentCopy: 'server' };
beforeEach(async () => {
  store = database(); auth = await oauthServer(); mail = await oauthMailServer();
  const vault = new Vault(Buffer.alloc(32));
  service = new MailService(store, vault, new BodyCache(resolve('.test-artifacts/oauth-api-unused')), (config, token) => new ImapAdapter({ ...config,
    imap: { ...config.imap, host: '127.0.0.1', port: mail.imapPort, security: 'plain' },
    smtp: { ...config.smtp, host: '127.0.0.1', port: mail.smtpPort, security: 'plain' } }, undefined, token), undefined, new OAuthManager(store, vault, auth.endpoints));
  app = createApp({ service, passwordHash: await hashPassword('oauth-test-password'), port: 3000 });
  cookie = await login();
});
afterEach(async () => { await service.stop(); await auth.close(); await mail.close(); store.close(); });

it('completes OAuth through authenticated APIs without exposing tokens and is idempotent on completion', async () => {
  const started = await (await request('/oauth/start', 'POST', { provider: 'google', account, client: { source: 'preset' } })).json();
  const callback = await callbackUrl(started.authorizationUrl);
  expect((await request(`/oauth/sessions/${started.id}/callback`, 'POST', { url: callback })).status).toBe(200);
  const complete = await (await request(`/oauth/sessions/${started.id}/complete`, 'POST', {})).json();
  expect(complete.status).toBe('complete');
  const again = await (await request(`/oauth/sessions/${started.id}/complete`, 'POST', {})).json();
  expect(again.accountId).toBe(complete.accountId); expect(store.accounts()).toHaveLength(1);
  for (const path of ['/accounts', `/accounts/${complete.accountId}`, `/oauth/sessions/${started.id}`]) {
    const result = await (await request(path)).text();
    expect(result).not.toMatch(/access-1|refresh-1|clientSecret|encryptedConfig/);
  }
  expect((await request(`/accounts/${complete.accountId}`, 'PUT', { ...account, name: 'renamed' })).status).toBe(200);
  expect(store.accounts()[0].name).toBe('renamed');
  expect((await request(`/accounts/${complete.accountId}`, 'PUT', { ...account, smtp: { ...account.smtp, host: 'wrong.example' } })).status).toBe(400);
});

it('binds sessions to a logged-in browser and cancels authorization at logout', async () => {
  const started = await (await request('/oauth/start', 'POST', { provider: 'google', account, client: { source: 'preset' } })).json();
  const other = await login();
  expect((await request(`/oauth/sessions/${started.id}`, 'GET', undefined, other)).status).not.toBe(200);
  const callback = await callbackUrl(started.authorizationUrl);
  expect((await request(`/oauth/sessions/${started.id}/callback`, 'POST', { url: callback }, other)).status).not.toBe(200);
  expect(auth.requests).toHaveLength(0);
  await request('/logout', 'POST', {});
  expect((await request(`/oauth/sessions/${started.id}`)).status).toBe(401);
  expect((await request('/oauth/start', 'POST', { provider: 'google', account, client: { source: 'preset' } }, '')).status).toBe(401);
});

it('stores global secrets without echoing them and serves the matching local tutorial', async () => {
  const saved = await request('/oauth/clients/google', 'PUT', { clientId: 'own', clientSecret: 'private-secret' });
  expect(saved.status).toBe(200); expect(await saved.text()).not.toContain('private-secret');
  expect(await (await request('/oauth/clients')).text()).not.toContain('private-secret');
  expect(await (await request('/oauth/docs/google')).text()).toContain('OAuth 客户端');
  expect((await request('/oauth/start', 'POST', { provider: 'google', account: accountConfig(), client: { source: 'preset' } })).status).toBe(400);
});

async function login() {
  const result = await request('/login', 'POST', { password: 'oauth-test-password' }, '');
  return result.headers.get('set-cookie')!.split(';')[0];
}
function request(path: string, method = 'GET', data?: unknown, sessionCookie = cookie) {
  return app.request(`http://127.0.0.1:3000/api${path}`, { method, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', cookie: sessionCookie },
    body: data === undefined ? undefined : JSON.stringify(data) });
}
