import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MailStore } from '@mail/db';
import { BodyCache, hashPassword, MailService, Vault } from '@mail/core';
import { migrations, record, seedAccount } from '../../../tests/fixtures';
import { createApp } from './app';

let directory: string;
let store: MailStore;
let service: MailService;
let app: ReturnType<typeof createApp>;
let passwordHash: string;
const password = 'remote-test-password';
beforeEach(async () => {
  mkdirSync('.test-artifacts', { recursive: true }); directory = mkdtempSync(resolve('.test-artifacts/remote-'));
  store = new MailStore(join(directory, 'mail.sqlite'), migrations);
  service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(join(directory, 'bodies')));
  passwordHash = await hashPassword(password);
  app = createApp({ service, passwordHash, port: 3000 });
});
afterEach(async () => { await service.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });

it('allows LAN, VPN and mapped IP ports without removing origin validation', async () => {
  for (const origin of ['http://192.168.1.20:3000', 'http://100.65.1.2:8080', 'http://[fd00::10]:3000']) {
    const cookie = await login(origin);
    expect((await request('/accounts', origin, 'GET', undefined, cookie)).status).toBe(200);
    const cross = await request('/accounts', origin, 'POST', {}, cookie, { origin: 'http://192.168.1.99:3000' });
    expect(cross.status).toBe(403);
  }
});

it('allows configured reverse proxy HTTPS and marks cookies Secure without trusting forwarded headers', async () => {
  app = createApp({ service, passwordHash, port: 3000, publicUrl: 'https://mail.example.com' });
  const response = await request('/login', 'https://mail.example.com', 'POST', { password });
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Secure');
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  expect((await request('/accounts', 'https://mail.example.com', 'GET', undefined, cookie)).status).toBe(200);
  const logout = await request('/logout', 'https://mail.example.com', 'POST', {}, cookie);
  expect(logout.headers.get('set-cookie')).toContain('Secure');
  expect((await request('/session', 'https://attacker.example', 'GET', undefined, cookie)).status).toBe(403);
  const direct = await request('/login', 'http://192.168.1.20:3000', 'POST', { password }, undefined,
    { 'x-forwarded-host': 'mail.example.com', 'x-forwarded-proto': 'https' });
  expect(direct.headers.get('set-cookie')).not.toContain('Secure');
});

it('supports application TLS cookies and only permits the Vite cross-origin exception in local development', async () => {
  app = createApp({ service, passwordHash, port: 3000, https: true });
  expect((await request('/login', 'https://192.168.1.20:3000', 'POST', { password })).headers.get('set-cookie')).toContain('Secure');
  expect((await request('/login', 'https://192.168.1.20:3000', 'POST', { password }, undefined, { origin: 'http://192.168.1.20:3000' })).status).toBe(403);
  app = createApp({ service, passwordHash, port: 3000, dev: true });
  expect((await request('/login', 'http://127.0.0.1:3000', 'POST', { password }, undefined, { origin: 'http://127.0.0.1:5173' })).status).toBe(200);
  expect((await request('/login', 'http://192.168.1.20:3000', 'POST', { password }, undefined, { origin: 'http://127.0.0.1:5173' })).status).toBe(403);
});

it('requires authentication for every registered private API, including downloads, OAuth and SSE', async () => {
  const { inbox } = seedAccount(store); store.applyBatch(inbox, [record()]);
  const routes = app.routes.filter(route => route.method !== 'ALL' && route.path.startsWith('/api/') && !['/api/login', '/api/session'].includes(route.path));
  expect(routes.length).toBeGreaterThan(25);
  for (const route of routes) {
    const path = route.path.slice(4).replace(/:[^/]+/g, 'some-id');
    const response = await request(path, 'http://192.168.1.20:3000', route.method, ['GET', 'HEAD'].includes(route.method) ? undefined : {});
    expect(response.status, `${route.method} ${route.path}`).toBe(401);
  }
  expect(store.accounts()).toHaveLength(1);
  const cookie = await login('http://192.168.1.20:3000');
  expect((await request('/accounts', 'http://192.168.1.20:3000', 'GET', undefined, cookie, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  expect((await app.request('http://192.168.1.20:3000/api/logout', { method: 'POST', headers: { cookie } })).status).toBe(403);
});

it('persists independent device sessions across database reopen and only stores token hashes', async () => {
  const origin = 'http://192.168.1.20:3000'; const phone = await login(origin); const desktop = await login(origin);
  const phoneToken = phone.split('=')[1];
  expect(JSON.stringify(store.sqlite.prepare('SELECT * FROM web_sessions').all())).not.toContain(phoneToken);
  await service.stop(); store.close();
  store = new MailStore(join(directory, 'mail.sqlite'), migrations);
  service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(join(directory, 'bodies')));
  app = createApp({ service, passwordHash, port: 3000 });
  expect((await request('/accounts', origin, 'GET', undefined, phone)).status).toBe(200);
  await request('/logout', origin, 'POST', {}, phone);
  expect((await request('/accounts', origin, 'GET', undefined, phone)).status).toBe(401);
  expect((await request('/accounts', origin, 'GET', undefined, desktop)).status).toBe(200);
  store.sqlite.exec('UPDATE web_sessions SET expires_at=0');
  expect((await request('/accounts', origin, 'GET', undefined, desktop)).status).toBe(401);
});

it('delivers changes to two devices and stops an event stream immediately at logout', async () => {
  const origin = 'http://192.168.1.20:3000'; const phone = await login(origin); const desktop = await login(origin);
  const readers = await Promise.all([phone, desktop].map(async cookie => {
    const response = await request('/events', origin, 'GET', undefined, cookie);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
    return reader;
  }));
  try {
    service.events.emit('update', { type: 'change', accountId: 'shared-account' });
    for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toContain('shared-account');
    await request('/logout', origin, 'POST', {}, phone);
    expect((await readers[0].read()).done).toBe(true);
    expect(service.events.listenerCount('update')).toBe(1);
    service.events.emit('update', { type: 'draft', accountId: 'still-signed-in' });
    expect(new TextDecoder().decode((await readers[1].read()).value)).toContain('still-signed-in');
    store.sqlite.exec('UPDATE web_sessions SET expires_at=0');
    service.events.emit('update', { type: 'change', accountId: 'must-not-leak' });
    expect((await readers[1].read()).done).toBe(true);
  } finally { await Promise.all(readers.map(reader => reader.cancel())); }
});

function request(path: string, origin: string, method = 'GET', data?: unknown, cookie?: string, extra?: Record<string, string>) {
  return app.request(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
    body: data === undefined ? undefined : JSON.stringify(data) });
}
async function login(origin: string) {
  const response = await request('/login', origin, 'POST', { password });
  expect(response.status).toBe(200); return response.headers.get('set-cookie')!.split(';')[0];
}
