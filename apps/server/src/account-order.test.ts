import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MailStore } from '@mail/db';
import { BodyCache, hashPassword, MailService, Vault } from '@mail/core';
import type { SyncEvent } from '@mail/shared';
import { migrations } from '../../../tests/fixtures';
import { createApp } from './app';

let directory: string;
let store: MailStore;
let service: MailService;
let app: ReturnType<typeof createApp>;
let ids: string[];
let cookie: string;
beforeEach(async () => {
  mkdirSync('.test-artifacts', { recursive: true }); directory = mkdtempSync(resolve('.test-artifacts/account-order-'));
  store = new MailStore(join(directory, 'mail.sqlite'), migrations);
  ids = ['Outlook', 'QQ', 'Gmail'].map(name => store.addAccount(name, `${name.toLowerCase()}@example.com`, 'encrypted-fixture'));
  service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(join(directory, 'bodies')));
  app = createApp({ service, passwordHash: await hashPassword('order-test-password'), port: 3000 });
  const login = await app.request('http://127.0.0.1:3000/api/login', { method: 'POST', headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'order-test-password' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => { await service.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });

it('saves account order across database reopen, notifies other devices, and appends new accounts', async () => {
  const updates: SyncEvent[] = []; service.events.on('update', event => updates.push(event));
  const ordered = [ids[1], ids[2], ids[0]];
  const response = await reorder(ordered);
  expect(response.status).toBe(200);
  expect((await response.json()).map((account: { id: string }) => account.id)).toEqual(ordered);
  expect(updates).toEqual([{ type: 'change', accountId: ids[1] }]);
  await service.stop(); store.close();
  store = new MailStore(join(directory, 'mail.sqlite'), migrations);
  expect(store.accounts().map(account => account.id)).toEqual(ordered);
  store.updateAccount(ids[0], 'Renamed', 'outlook@example.com', 'encrypted-fixture', false);
  const fourth = store.addAccount('New', 'new@example.com', 'encrypted-fixture');
  expect(store.accounts().map(account => account.id)).toEqual([...ordered, fourth]);
  store.deleteAccount(ids[2]);
  expect(store.accounts().map(account => account.id)).toEqual([ids[1], ids[0], fourth]);
});

it('rejects unauthenticated, duplicate, missing and unknown account lists without changing order', async () => {
  expect((await reorder([...ids].reverse(), '')).status).toBe(401);
  expect((await reorder([ids[0], ids[0], ids[2]])).status).toBe(400);
  expect((await reorder(ids.slice(1))).status).toBe(409);
  expect((await reorder([ids[0], ids[1], randomUUID()])).status).toBe(409);
  expect((await reorder([])).status).toBe(400);
  expect(store.accounts().map(account => account.id)).toEqual(ids);
});

function reorder(accountIds: string[], session = cookie) {
  return app.request('http://127.0.0.1:3000/api/accounts/order', { method: 'PUT', headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', cookie: session }, body: JSON.stringify({ accountIds }) });
}
