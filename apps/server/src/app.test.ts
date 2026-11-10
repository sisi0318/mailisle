import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BodyCache, hashPassword, MailService, Vault } from '@mail/core';
import { createApp } from './app';
import { database, record, seedAccount } from '../../../tests/fixtures';

describe('HTTP authentication and local data', () => {
  let directory: string;
  let store: ReturnType<typeof database>;
  let app: ReturnType<typeof createApp>;
  let service: MailService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mail-api-'));
    store = database(); service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(directory));
    app = createApp({ service, passwordHash: await hashPassword('test-login-password'), port: 3000 });
  });
  afterEach(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  function request(path: string, method = 'GET', data?: unknown, cookie?: string, extra?: Record<string, string>) {
    return app.request(`http://127.0.0.1:3000/api${path}`, { method, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  }
  async function login() {
    const response = await request('/login', 'POST', { password: 'test-login-password' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    return cookie.split(';')[0];
  }
  it('requires login and invalidates the cookie on logout', async () => {
    expect((await request('/accounts')).status).toBe(401);
    const cookie = await login();
    expect((await request('/accounts', 'GET', undefined, cookie)).status).toBe(200);
    await request('/logout', 'POST', {}, cookie);
    expect((await request('/accounts', 'GET', undefined, cookie)).status).toBe(401);
  });
  it('blocks rebinding hosts, cross-site origins and missing origins', async () => {
    expect((await request('/session', 'GET', undefined, undefined, { host: 'attacker.example:3000' })).status).toBe(403);
    expect((await request('/login', 'POST', {}, undefined, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await app.request('http://127.0.0.1:3000/api/login', { method: 'POST', body: '{}' })).status).toBe(403);
  });
  it('does not return encrypted account credentials and rejects malformed input', async () => {
    const { inbox } = seedAccount(store);
    store.applyBatch(inbox, [record()]);
    const cookie = await login();
    const accounts = await (await request('/accounts', 'GET', undefined, cookie)).json();
    expect(accounts[0]).not.toHaveProperty('encryptedConfig');
    const result = await (await request('/messages?q=发票', 'GET', undefined, cookie)).json();
    expect(result.total).toBe(1);
    expect((await request('/messages?limit=-1', 'GET', undefined, cookie)).status).toBe(400);
    expect((await request('/send', 'POST', { to: ['bad'] }, cookie)).status).toBe(400);
    expect((await request('/messages/missing/body', 'GET', undefined, cookie)).status).toBe(404);
    expect((await request('/messages/../../settings/body', 'GET', undefined, cookie)).status).toBe(404);
  });
  it('limits repeated incorrect logins', async () => {
    for (let i = 0; i < 10; i++) expect((await request('/login', 'POST', { password: 'incorrect-password' })).status).toBe(401);
    expect((await request('/login', 'POST', { password: 'incorrect-password' })).status).toBe(429);
  });
});
