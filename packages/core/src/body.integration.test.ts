import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { listSchema, type Folder } from '@mail/shared';
import { accountConfig, database, record } from '../../../tests/fixtures';
import { ImapAdapter } from './imap';
import { BodyCache } from './cache';
import { BodyPrefetcher } from './body-prefetcher';

const config = accountConfig();
const path = `body-${randomUUID()}`;
let direct: ImapFlow;
let adapter: ImapAdapter;
let folder: Folder;
let uids: number[];

beforeAll(async () => {
  direct = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, doSTARTTLS: false,
    auth: { user: config.imap.user, pass: config.imap.password }, logger: false });
  direct.on('error', () => {});
  await direct.connect(); await direct.mailboxCreate(path);
  const plain = Buffer.from('From: alice@example.com\r\nTo: bob@example.com\r\nSubject: GBK\r\nContent-Type: text/plain; charset=gb18030\r\nContent-Transfer-Encoding: base64\r\n\r\n1tDOxA==\r\n');
  const html = await new MailComposer({ from: config.email, to: config.email, html: '<p>电子发票正文</p><a href="https://example.com/track">查看明细</a>' }).compile().build();
  const multipart = await new MailComposer({ from: config.email, to: config.email,
    text: '报销合同的文本正文', html: '<p>报销合同的文本正文</p><img src="cid:logo">',
    attachments: [
      { filename: 'should-not-download.txt', content: 'ATTACHMENT_MUST_NOT_BE_INDEXED', contentType: 'text/plain' },
      { filename: 'logo.png', content: Buffer.from('iVBORw0KGgo=', 'base64'), contentType: 'image/png', cid: 'logo' },
    ] }).compile().build();
  for (const source of [plain, html, multipart]) await direct.append(path, source);
  const mailbox = await direct.mailboxOpen(path);
  if (!mailbox) throw new Error('Test mailbox unavailable');
  const found = await direct.search({ all: true }, { uid: true });
  if (found === false) throw new Error('Test SEARCH failed');
  uids = found;
  folder = { id: path, accountId: 'test', path, name: path, role: 'other', uidValidity: mailbox.uidValidity.toString(), uidNext: mailbox.uidNext, modseq: null };
  adapter = new ImapAdapter(config); await adapter.connect();
});
afterAll(async () => { await adapter?.close(); try { await direct?.mailboxDelete(path); } finally { direct?.close(); } });

it('decodes single-part GB18030, HTML-only, and multipart text without fetching attachments or setting Seen', async () => {
  const fetch = vi.spyOn(ImapFlow.prototype, 'fetchOne');
  try {
    expect((await adapter.bodyText(folder, uids[0])).trim()).toBe('中文');
    expect(await adapter.bodyText(folder, uids[1])).toContain('电子发票正文');
    const multipart = await adapter.bodyText(folder, uids[2]);
    expect(multipart).toContain('报销合同的文本正文');
    expect(multipart).not.toContain('ATTACHMENT_MUST_NOT_BE_INDEXED');
    expect(fetch.mock.calls.every(([, query]) => !query.source)).toBe(true);
    const parts = fetch.mock.calls.filter(([, query]) => query.bodyParts);
    expect(parts).toHaveLength(3);
    expect(parts.every(([, query]) => query.bodyParts?.length === 1)).toBe(true);
  } finally { fetch.mockRestore(); }
  for (const message of await direct.fetchAll(uids, { flags: true }, { uid: true })) expect(message.flags?.has('\\Seen')).toBe(false);
});

it('makes unopened bodies searchable and leaves full MIME caching until the reader opens them', async () => {
  await mkdir('.test-artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('.test-artifacts/body-protocol-'));
  const store = database();
  const accountId = store.addAccount('测试', config.email, 'unused');
  const [local] = store.saveFolders(accountId, [{ path, name: path, role: 'inbox' }]);
  store.beginFolder(local.id, folder.uidValidity);
  store.applyBatch(store.folder(local.id)!, uids.map(uid => record(uid, { subject: '未打开的邮件' })));
  const cache = new BodyCache(directory);
  const events = { change: vi.fn(), error: vi.fn() };
  const worker = new BodyPrefetcher(store, cache, () => new ImapAdapter(config), events);
  try {
    worker.start(); await worker.schedule(accountId);
    expect(events.error).not.toHaveBeenCalled();
    expect(store.pendingBodies(accountId)).toEqual([]);
    const result = store.list(listSchema.parse({ q: '报销合同' }));
    expect(result.total).toBe(1);
    expect(result.messages[0].cached).toBe(false);
    expect(await cache.read(result.messages[0].id)).toBeNull();
    const invoice = store.list(listSchema.parse({ q: '电子发票正文' })).messages[0];
    expect(invoice.preview).toContain('查看明细');
    expect(invoice.preview).not.toContain('https://');
  } finally { await worker.stop(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
