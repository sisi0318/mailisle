import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BodyCache, hashPassword, MailService, UploadStore, Vault } from '@mail/core';
import { MAX_ATTACHMENT_BYTES } from '@mail/shared';
import { createApp } from './app';
import { UpdateChecker } from './updates';
import { accountConfig, database, record, seedAccount } from '../../../tests/fixtures';

describe('HTTP authentication and local data', () => {
  let directory: string;
  let store: ReturnType<typeof database>;
  let app: ReturnType<typeof createApp>;
  let service: MailService;
  beforeEach(async () => {
    await mkdir('.test-artifacts', { recursive: true });
    directory = await mkdtemp(resolve('.test-artifacts/mail-api-'));
    store = database(); service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(directory), undefined, new UploadStore(store, resolve(directory, 'uploads')));
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
  it('keeps global proxy credentials encrypted and exposes only a redacted address', async () => {
    expect((await request('/settings/proxy', 'PUT', { proxy: 'http://127.0.0.1:7890' })).status).toBe(401);
    const cookie = await login();
    const changed = await request('/settings/proxy', 'PUT', { proxy: 'http://proxy-user:proxy-secret@127.0.0.1:7890' }, cookie);
    expect(changed.status).toBe(200); expect(await changed.json()).toEqual({ configured: true, display: 'http://127.0.0.1:7890' });
    expect(store.getSetting('global-proxy')).not.toContain('proxy-secret');
    expect(await (await request('/settings/proxy', 'GET', undefined, cookie)).text()).not.toContain('proxy-secret');
    expect((await request('/settings/proxy', 'PUT', { proxy: 'file:///tmp/secret' }, cookie)).status).toBe(400);
    const cleared = await request('/settings/proxy', 'PUT', { proxy: null }, cookie);
    expect(await cleared.json()).toEqual({ configured: false });
  });
  it('checks updates only after login and returns the recorded build identity', async () => {
    const build = { version: '0.1.0', revision: 'a'.repeat(40), localChanges: false, builtAt: '2026-11-12T00:00:00.000Z' };
    let calls = 0;
    const updates = new UpdateChecker(build, async () => { calls++; return { sha: build.revision, commit: { message: 'current', committer: { date: build.builtAt } } }; });
    app = createApp({ service, passwordHash: await hashPassword('test-login-password'), port: 3000, updates });
    expect((await request('/version')).status).toBe(401);
    expect((await request('/updates/check', 'POST', {})).status).toBe(401); expect(calls).toBe(0);
    const cookie = await login();
    expect(await (await request('/version', 'GET', undefined, cookie)).json()).toEqual(build);
    expect((await (await request('/updates/check', 'POST', {}, cookie)).json()).status).toBe('current'); expect(calls).toBe(1);
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

  it('reads nothing large from a client that has not logged in', async () => {
    const big = 'x'.repeat(64 * 1024);
    expect((await request('/login', 'POST', { password: big })).status).toBe(413);
    expect((await request('/drafts', 'POST', { text: big })).status).toBe(401);
    const chunked = await app.request('http://127.0.0.1:3000/api/login', { method: 'POST', duplex: 'half',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ password: big }))); controller.close(); } }) } as RequestInit);
    expect(chunked.status).toBe(413);
    expect((await request('/accounts', 'GET', undefined, undefined, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await request('/login', 'POST', undefined, undefined, { 'content-type': 'application/json' })).status).toBe(400);
  });

  it('returns cached CID data through the authenticated body API while attachments stay downloads', async () => {
    const { inbox } = seedAccount(store);
    store.applyBatch(inbox, [record()]);
    const id = (store.sqlite.prepare('SELECT id FROM messages').get() as { id: string }).id;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5kAAAAASUVORK5CYII=';
    await service.cache.save(id, Buffer.from([
      'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary=test', '',
      '--test', 'Content-Type: text/html; charset=utf-8', '', '<img src="cid:logo">',
      '--test', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Disposition: inline; filename="logo.png"',
      'Content-Transfer-Encoding: base64', '', png, '--test--', '',
    ].join('\r\n')));
    expect((await request(`/messages/${id}/body`)).status).toBe(401);
    const cookie = await login();
    const body = await (await request(`/messages/${id}/body`, 'GET', undefined, cookie)).json();
    expect(body.inlineImages).toEqual([{ attachmentId: '0', contentId: 'logo', dataUrl: `data:image/png;base64,${png}` }]);
    const download = await request(`/messages/${id}/attachments/0`, 'GET', undefined, cookie);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(png, 'base64'));
  });

  it('exposes editable settings without stored credentials', async () => {
    const config = { ...accountConfig(), proxy: 'http://proxy-user:proxy-secret@127.0.0.1:7890' };
    const id = store.addAccount('测试', config.email, new Vault(Buffer.alloc(32)).encrypt(config));
    const cookie = await login();
    const response = await request(`/accounts/${id}`, 'GET', undefined, cookie);
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.imap).not.toHaveProperty('password'); expect(body.smtp).not.toHaveProperty('password');
    expect(JSON.stringify(body)).not.toContain('proxy-secret'); expect(body.proxyDisplay).toBe('http://127.0.0.1:7890');
    expect((await request(`/accounts/${id}`)).status).toBe(401);
  });

  it('uploads a real multipart attachment, saves a local draft and removes both on discard', async () => {
    const { accountId } = seedAccount(store);
    const cookie = await login();
    const form = new FormData(); form.set('file', new File([new Uint8Array([0, 1, 255])], '合同.bin', { type: 'application/octet-stream' }));
    const upload = await app.request('http://127.0.0.1:3000/api/uploads', { method: 'POST', headers: { origin: 'http://127.0.0.1:3000', cookie }, body: form });
    expect(upload.status).toBe(201);
    const file = await upload.json(); expect(file.size).toBe(3);
    expect((await request(`/uploads/${file.id}`)).status).toBe(401);
    const download = await request(`/uploads/${file.id}`, 'GET', undefined, cookie);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from([0, 1, 255]));
    const created = await request('/drafts', 'POST', { accountId, to: '还没填完@', subject: '草稿', text: '内容', attachmentIds: [file.id] }, cookie);
    expect(created.status).toBe(201);
    const draft = await created.json(); expect(draft.attachments[0].filename).toBe('合同.bin');
    const reopened = await (await request(`/drafts/${draft.id}`, 'GET', undefined, cookie)).json();
    expect(reopened.to).toBe('还没填完@');
    expect((await (await request('/counts', 'GET', undefined, cookie)).json()).drafts).toBe(1);
    expect((await request(`/drafts/${draft.id}`)).status).toBe(401);
    expect((await request(`/drafts/${draft.id}`, 'DELETE', undefined, cookie)).status).toBe(200);
    expect(store.upload(file.id)).toBeUndefined();
    expect((await request('/uploads', 'POST', {}, cookie)).status).toBe(415);
  });

  it('rejects oversized uploads before storing them', async () => {
    const cookie = await login();
    const form = new FormData(); form.set('file', new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.bin'));
    const response = await app.request('http://127.0.0.1:3000/api/uploads', { method: 'POST', headers: { origin: 'http://127.0.0.1:3000', cookie }, body: form });
    expect(response.status).toBe(413);
    expect(store.sqlite.prepare('SELECT count(*) n FROM uploads').get()).toEqual({ n: 0 });
  });
  it('authenticates and validates update preferences and folder deletion', async () => {
    expect((await request('/settings/updates')).status).toBe(401);
    expect((await request('/updates/open', 'POST', {})).status).toBe(401);
    const { inbox } = seedAccount(store);
    expect((await request(`/folders/${inbox.id}`, 'DELETE')).status).toBe(401);
    const cookie = await login();
    const settings = { enabled: true, useGlobalProxy: false, frequency: 'weekly', channel: 'ci' };
    expect((await request('/settings/updates', 'PUT', { ...settings, channel: 'invalid' }, cookie)).status).toBe(400);
    expect((await request('/settings/updates', 'PUT', settings, cookie)).status).toBe(200);
    expect(await (await request('/settings/updates', 'GET', undefined, cookie)).json()).toEqual(settings);
    expect((await request(`/folders/${inbox.id}`, 'DELETE', undefined, cookie)).status).toBe(400);
    expect(store.folder(inbox.id)).toBeDefined();
    expect((await request('/folders/missing', 'DELETE', undefined, cookie)).status).toBe(404);
  });
});
