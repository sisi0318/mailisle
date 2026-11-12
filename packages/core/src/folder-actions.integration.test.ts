import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { accountConfig, database } from '../../../tests/fixtures';
import { BodyCache } from './cache';
import { Vault } from './crypto';
import { MailService } from './service';
import { listSchema } from '@mail/shared';

const config = accountConfig(); const prefix = `actions-${randomUUID()}`;
let store: ReturnType<typeof database>; let service: MailService; let direct: ImapFlow; let accountId: string; let directory: string;
beforeAll(async () => {
  await mkdir('.test-artifacts', { recursive: true }); directory = await mkdtemp(resolve('.test-artifacts/folder-actions-'));
  store = database(); service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(directory));
  direct = new ImapFlow({ host: config.imap.host, port: config.imap.port, secure: false, doSTARTTLS: false, auth: { user: config.imap.user, pass: config.imap.password }, logger: false });
  direct.on('error', () => {}); await direct.connect();
  await direct.mailboxCreate(`${prefix}-a`); await direct.mailboxCreate(`${prefix}-b`);
  const raw = await new MailComposer({ from: config.email, to: config.email, subject: prefix, text: 'Folder action fixture' }).compile().build();
  await direct.append(`${prefix}-a`, raw, ['\\Flagged']); await direct.append(`${prefix}-b`, raw);
  accountId = await service.addAccount(config); await service.sync(accountId);
});
afterAll(async () => {
  await service?.stop();
  if (direct?.usable) {
    const folders = (await direct.list()).filter(folder => folder.path.startsWith(prefix)).sort((a, b) => b.path.length - a.path.length);
    for (const folder of folders) await direct.mailboxDelete(folder.path);
  }
  direct?.close(); store?.close(); if (directory) await rm(directory, { recursive: true, force: true });
});

it('marks one folder read on the server and locally without clearing stars or changing sibling mail', async () => {
  const folder = store.folders(accountId).find(folder => folder.path === `${prefix}-a`)!;
  await service.markAllRead(accountId, folder.id); await service.sync(accountId);
  await direct.mailboxOpen(`${prefix}-a`);
  const first = await direct.fetchOne(1, { flags: true });
  expect(first && first.flags?.has('\\Seen')).toBe(true); expect(first && first.flags?.has('\\Flagged')).toBe(true);
  await direct.mailboxOpen(`${prefix}-b`);
  const sibling = await direct.fetchOne(1, { flags: true }); expect(sibling && sibling.flags?.has('\\Seen')).toBe(false);
  expect(store.list(listSchema.parse({ accountId, folderId: folder.id, view: 'all' })).messages[0]).toMatchObject({ seen: true, starred: true });
});
it('marks every selectable folder read when invoked for the account', async () => {
  await service.markAllRead(accountId); await service.sync(accountId);
  for (const path of [`${prefix}-a`, `${prefix}-b`]) {
    await direct.mailboxOpen(path); const message = await direct.fetchOne(1, { flags: true });
    expect(message && message.flags?.has('\\Seen')).toBe(true);
  }
  expect(store.unreadCounts().accounts[accountId] ?? 0).toBe(0);
});
it('creates a root folder and a child using the server hierarchy, and rejects duplicates', async () => {
  const root = await service.createFolder(accountId, `${prefix}-new`);
  expect(root).toBeDefined();
  const child = await service.createFolder(accountId, '子文件夹', root!.id);
  expect(child?.path).toContain('子文件夹'); expect(child?.path.startsWith(root!.path)).toBe(true);
  expect((await direct.list()).some(folder => folder.path === child?.path)).toBe(true);
  await expect(service.createFolder(accountId, `${prefix}-new`)).rejects.toThrow();
  const delimiter = (await direct.list()).find(folder => folder.path === root!.path)!.delimiter;
  await expect(service.createFolder(accountId, `wrong${delimiter}level`, root!.id)).rejects.toThrow('分隔符');
});
