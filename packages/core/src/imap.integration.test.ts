import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { listSchema, type Folder, type MailFlags, type MailMetadata } from '@mail/shared';
import { MailStore } from '@mail/db';
import { accountConfig, migrations } from '../../../tests/fixtures';
import { ImapAdapter } from './imap';
import { BodyCache } from './cache';
import { MailService } from './service';
import { Vault } from './crypto';

describe('real GreenMail IMAP / SMTP round trip', () => {
  let directory: string;
  let store: MailStore;
  let service: MailService;
  let direct: ImapFlow;
  let accountId: string;
  let inbox: Folder;
  const unique = `integration-${Date.now()}`;
  const config = accountConfig();
  const search = (q: string) => store.list(listSchema.parse({ q, view: 'all' }));

  beforeAll(async () => {
    await mkdir('.test-artifacts', { recursive: true });
    directory = await mkdtemp(resolve('.test-artifacts/integration-'));
    store = new MailStore(resolve(directory, 'mail.sqlite'), migrations);
    service = new MailService(store, new Vault(Buffer.alloc(32, 1)), new BodyCache(resolve(directory, 'bodies')));
    direct = new ImapFlow({ host: config.imap.host, port: config.imap.port, secure: false, doSTARTTLS: false,
      auth: { user: config.imap.user, pass: config.imap.password }, logger: false });
    direct.on('error', () => {});
    await direct.connect();
    const paths = new Set((await direct.list()).map(folder => folder.path));
    for (const name of ['Sent', 'Trash', 'Archive']) if (!paths.has(name)) await direct.mailboxCreate(name);
    accountId = await service.addAccount(config);
    await service.sync(accountId);
    inbox = store.folders(accountId).find(folder => folder.role === 'inbox')!;
    expect(store.account(accountId)?.error).toBeNull();
    expect(store.account(accountId)?.encryptedConfig).not.toContain(config.imap.password);
  });
  afterAll(async () => {
    direct?.close();
    await service?.stop();
    store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('syncs MIME metadata, caches an attachment, indexes body text and resumes without duplicates', async () => {
    const raw = await new MailComposer({ from: 'Finance <finance@example.com>', to: config.email,
      subject: `${unique} 电子发票`, text: '合同正文已核对，报销单据见附件。', html: '<p>合同正文已核对。</p>',
      messageId: `<${unique}@example.com>`, attachments: [{ filename: '发票.txt', content: '附件内容', contentType: 'text/plain' }] }).compile().build();
    await direct.append('INBOX', raw);
    await service.sync(accountId);
    const found = search(unique);
    expect(found.total).toBe(1);
    expect(found.messages[0].subject).toContain('电子发票');
    const [body, secondReader] = await Promise.all([service.body(found.messages[0].id), service.body(found.messages[0].id)]);
    expect(secondReader).toEqual(body);
    expect(body.text).toContain('报销');
    expect(body.attachments[0].filename).toBe('发票.txt');
    expect((await service.cache.attachment(found.messages[0].id, '0')).toString()).toBe('附件内容');
    expect(search('报销').messages.some(message => message.id === found.messages[0].id)).toBe(true);
    await service.sync(accountId);
    expect(search(unique).total).toBe(1);
  });
  it('propagates flags and moves to the server and reconciles deletions', async () => {
    const message = search(unique).messages[0];
    await service.flags(message.id, { seen: true, starred: true });
    expect(store.message(message.id)).toMatchObject({ seen: true, starred: true });
    const location = store.messageLocations(message.id)[0];
    const lock = await direct.getMailboxLock('INBOX');
    const remote = await direct.fetchOne(location.uid, { flags: true }, { uid: true });
    lock.release();
    expect(remote && remote.flags?.has('\\Flagged')).toBe(true);
    const trash = store.folders(accountId).find(folder => folder.role === 'trash')!;
    await service.move(message.id, trash.id);
    expect(store.list(listSchema.parse({ folderId: inbox.id, q: unique })).total).toBe(0);
    const moved = store.list(listSchema.parse({ folderId: trash.id, q: unique })).messages[0];
    expect(moved).toBeDefined();
    const trashLocation = store.messageLocations(moved.id)[0];
    const trashLock = await direct.getMailboxLock(trash.path);
    await direct.messageDelete(trashLocation.uid, { uid: true });
    trashLock.release();
    await service.sync(accountId);
    expect(search(unique).total).toBe(0);
  });
  it('sends SMTP, appends exactly one sent copy, and delivers to a second mailbox', async () => {
    const subject = `${unique} outbound`;
    const result = await service.send({ accountId, to: ['bob@example.com'], cc: [], bcc: [], subject,
      text: '真实 SMTP 收发测试', html: '<p>真实 SMTP 收发测试</p>', references: [], attachmentIds: [] });
    expect(result.warning).toBeUndefined();
    await service.sync(accountId);
    const sent = store.folders(accountId).find(folder => folder.role === 'sent')!;
    expect(store.list(listSchema.parse({ folderId: sent.id, q: subject })).total).toBe(1);
    const bob = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, doSTARTTLS: false,
      auth: { user: 'bob@example.com', pass: 'test-password' }, logger: false });
    bob.on('error', () => {});
    try {
      await bob.connect(); await bob.mailboxOpen('INBOX');
      const uids = await bob.search({ header: { subject } }, { uid: true });
      expect(uids && uids.length).toBe(1);
    } finally { bob.close(); }
  });
  it('observes a new arrival through the dedicated IDLE connection', async () => {
    const adapter = new ImapAdapter(config);
    let resolveChange: () => void;
    const changed = new Promise<void>(resolve => { resolveChange = resolve; });
    const stop = await adapter.watchInbox(() => resolveChange(), () => {});
    try {
      const raw = await new MailComposer({ from: 'idle@example.com', to: config.email, subject: `${unique} idle`, text: 'IDLE' }).compile().build();
      await direct.append('INBOX', raw);
      await Promise.race([changed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('IDLE notification timed out')), 10_000); timer.unref(); })]);
    } finally { stop(); await adapter.close(); }
  });
  it('rejects invalid SMTP credentials before storing an account', async () => {
    const before = store.accounts().length;
    await expect(service.addAccount({ ...config, smtp: { ...config.smtp, password: 'incorrect-test-password' } })).rejects.toThrow();
    expect(store.accounts()).toHaveLength(before);
  });
  it('does not append a second copy when server-side sent saving is selected', async () => {
    const adapter = new ImapAdapter({ ...config, sentCopy: 'server' });
    const subject = `${unique} server-copy`;
    try {
      await adapter.connect();
      await adapter.send({ accountId, to: ['bob@example.com'], cc: [], bcc: [], subject, text: '服务端副本模式测试', references: [], attachmentIds: [] }, 'Sent');
      const lock = await direct.getMailboxLock('Sent');
      try { expect(await direct.search({ header: { subject } }, { uid: true })).toEqual([]); }
      finally { lock.release(); }
    } finally { await adapter.close(); }
  });

  it('fetches envelopes only for unknown UIDs and uses flags-only fetches for existing mail', async () => {
    await service.sync(accountId);
    const path = `${unique}-incremental`;
    await direct.mailboxCreate(path);
    const raw = await new MailComposer({ from: config.email, to: config.email, subject: '增量测试', text: '正文' }).compile().build();
    await direct.append(path, raw);
    await direct.append(path, raw);
    const adapter = new ImapAdapter(config);
    let folder: Folder = { id: path, accountId, path, name: path, role: 'other', uidValidity: '', uidNext: 1, modseq: null };
    const messages: MailMetadata[] = [];
    const flags: MailFlags[] = [];
    const sink = { knownUids: [] as number[], begin: () => {}, messages: (batch: MailMetadata[]) => { messages.push(...batch); }, flags: (batch: MailFlags[]) => { flags.push(...batch); } };
    try {
      await adapter.connect();
      const initial = await adapter.sync(folder, sink);
      expect(initial.cursor.modseq).toBeNull(); // GreenMail exercises the non-CONDSTORE path.
      folder = { ...folder, ...initial.cursor };
      sink.knownUids = initial.uids;
      messages.length = 0;
      await adapter.flags(folder, initial.uids[0], { seen: true });
      await direct.append(path, raw);
      const fetched = vi.spyOn(ImapFlow.prototype, 'fetchAll');
      try {
        const next = await adapter.sync(folder, sink);
        expect(messages).toHaveLength(1);
        expect(initial.uids).not.toContain(messages[0].uid);
        expect(flags.find(item => item.uid === initial.uids[0])?.flags).toContain('\\Seen');
        const envelopeCalls = fetched.mock.calls.filter(([, query]) => query.envelope);
        expect(envelopeCalls).toHaveLength(1);
        expect(envelopeCalls[0][0]).toEqual([messages[0].uid]);
        expect(fetched.mock.calls.find(([, query]) => !query.envelope)?.[1]).toEqual({ uid: true, flags: true });

        // An older UID may become visible after changing the provider's client sync range.
        messages.length = 0;
        sink.knownUids = next.uids.filter(uid => uid !== initial.uids[0]);
        await adapter.sync({ ...folder, ...next.cursor }, sink);
        expect(messages.map(item => item.uid)).toEqual([initial.uids[0]]);
      } finally { fetched.mockRestore(); }

      const connect = vi.spyOn(ImapFlow.prototype, 'connect');
      try {
        await adapter.connect();
        await adapter.source(folder, initial.uids[0]);
        expect(connect).not.toHaveBeenCalled();
        await adapter.close();
        await adapter.connect();
        await adapter.source(folder, initial.uids[0]);
        expect(connect).toHaveBeenCalledOnce();
      } finally { connect.mockRestore(); }
    } finally { await adapter.close(); await direct.mailboxDelete(path); }
  });

  it('lets a queued flag command run between two metadata batches on the same connection', async () => {
    await service.sync(accountId);
    const path = `${unique}-batches`;
    await direct.mailboxCreate(path);
    const raw = await new MailComposer({ from: config.email, to: config.email, subject: '分批测试', text: '正文' }).compile().build();
    for (let i = 0; i < 201; i++) await direct.append(path, raw);
    const adapter = new ImapAdapter(config);
    const folder: Folder = { id: path, accountId, path, name: path, role: 'other', uidValidity: '', uidNext: 1, modseq: null };
    let flagRequest: Promise<void> | undefined;
    let firstUid = 0;
    await adapter.connect();
    const fetched = vi.spyOn(ImapFlow.prototype, 'fetchAll');
    const flagged = vi.spyOn(ImapFlow.prototype, 'messageFlagsAdd');
    try {
      const result = await adapter.sync(folder, {
        knownUids: [], begin: validity => { folder.uidValidity = validity; }, flags: () => {},
        messages: records => {
          if (!flagRequest) {
            firstUid = records[0].uid;
            flagRequest = adapter.flags(folder, firstUid, { seen: true });
          }
        },
      });
      await flagRequest;
      expect(result.uids).toHaveLength(201);
      expect(fetched).toHaveBeenCalledTimes(2);
      expect(flagged.mock.invocationCallOrder[0]).toBeGreaterThan(fetched.mock.invocationCallOrder[0]);
      expect(flagged.mock.invocationCallOrder[0]).toBeLessThan(fetched.mock.invocationCallOrder[1]);
    } finally { fetched.mockRestore(); flagged.mockRestore(); await adapter.close(); await direct.mailboxDelete(path); }
  });
});
