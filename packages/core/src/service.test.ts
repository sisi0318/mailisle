import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Folder, MoveReceipt } from '@mail/shared';
import { accountConfig, database, record } from '../../../tests/fixtures';
import { BodyCache } from './cache';
import { Vault } from './crypto';
import { MailService } from './service';
import { UploadStore } from './uploads';
import { accountUpdateSchema, draftSchema, sendSchema } from '@mail/shared';
import type { MailAdapter, SyncSink } from './adapter';
import type { AccountConfig } from './oauth';

let store: ReturnType<typeof database>;
let directory: string;
let service: MailService;
let accountId: string;
let inbox: Folder;
let sent: Folder;
let messageId: string;
let notify: () => void;
let adapter: ReturnType<typeof serverAdapter>;
let factory: ReturnType<typeof vi.fn<(config: AccountConfig) => MailAdapter>>;

beforeEach(async () => {
  await mkdir('.test-artifacts', { recursive: true });
  directory = await mkdtemp(resolve('.test-artifacts/service-'));
  store = database();
  const vault = new Vault(Buffer.alloc(32));
  accountId = store.addAccount('测试', 'alice@example.com', vault.encrypt(accountConfig()));
  store.saveFolders(accountId, [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }, { path: 'Sent', name: 'Sent', role: 'sent' }]);
  for (const folder of store.folders(accountId)) store.beginFolder(folder.id, '1');
  inbox = store.folders(accountId).find(folder => folder.role === 'inbox')!;
  sent = store.folders(accountId).find(folder => folder.role === 'sent')!;
  store.applyBatch(inbox, [record()]);
  messageId = (store.sqlite.prepare('SELECT id FROM messages').get() as { id: string }).id;
  adapter = serverAdapter();
  factory = vi.fn(() => adapter);
  service = new MailService(store, vault, new BodyCache(directory), factory, new UploadStore(store, join(directory, 'uploads')), undefined, { cleanupMs: 40, verifyMs: 40 });
});
afterEach(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });

it('reuses the account adapter and commits flags after acknowledgement without starting a sync', async () => {
  const acknowledged = deferred();
  adapter.flags.mockImplementationOnce(() => acknowledged.promise);
  const flagRequest = service.flags(messageId, { seen: true });
  await vi.waitFor(() => expect(adapter.flags).toHaveBeenCalledOnce());
  expect(store.message(messageId)?.seen).toBe(false);
  acknowledged.resolve();
  await flagRequest;
  expect(store.message(messageId)?.seen).toBe(true);
  await service.body(messageId);
  await service.flags(messageId, { starred: true });
  expect(factory).toHaveBeenCalledOnce();
  expect(adapter.sync).not.toHaveBeenCalled();
  expect(adapter.close).not.toHaveBeenCalled();
  await service.stop();
  expect(adapter.close).toHaveBeenCalledOnce();
});

it('leaves local flags unchanged when the server rejects the operation', async () => {
  adapter.flags.mockRejectedValueOnce(new Error('server rejected flag change'));
  await expect(service.flags(messageId, { seen: true })).rejects.toThrow('rejected');
  expect(store.message(messageId)?.seen).toBe(false);
});

it('returns a mapped move without waiting for account synchronization', async () => {
  await service.move(messageId, sent.id);
  expect(store.messageLocations(messageId)).toMatchObject([{ uid: 10, folder: { id: sent.id } }]);
  expect(adapter.sync).not.toHaveBeenCalled();
});

it('allows a flag operation to finish while a sync is between batches', async () => {
  const started = deferred();
  const release = deferred();
  const original = adapter.sync.getMockImplementation()!;
  adapter.sync.mockImplementationOnce(async (folder, sink) => { started.resolve(); await release.promise; return original(folder, sink); });
  let finished = false;
  const sync = service.sync(accountId).then(() => { finished = true; });
  try {
    await started.promise;
    await service.flags(messageId, { seen: true });
    expect(store.message(messageId)?.seen).toBe(true);
    expect(finished).toBe(false);
  } finally { release.resolve(); await sync; }
});

it('coalesces notifications received during a sync into a follow-up pass', async () => {
  await service.sync(accountId);
  adapter.sync.mockClear();
  const started = deferred();
  const release = deferred();
  const original = adapter.sync.getMockImplementation()!;
  adapter.sync.mockImplementationOnce(async (folder, sink) => { started.resolve(); await release.promise; return original(folder, sink); });
  const sync = service.sync(accountId);
  try { await started.promise; notify(); notify(); notify(); }
  finally { release.resolve(); await sync; }
  expect(adapter.sync).toHaveBeenCalledTimes(4); // two folders, two passes
});

it('closes the reusable connection and listener when removing an account', async () => {
  await service.sync(accountId);
  await service.deleteAccount(accountId);
  expect(adapter.close).toHaveBeenCalledOnce();
  expect(adapter.stopWatch).toHaveBeenCalledOnce();
  expect(store.account(accountId)).toBeUndefined();
});

it('hides saved passwords and proxy credentials, and preserves blank secrets during account editing', async () => {
  const vault = new Vault(Buffer.alloc(32));
  store.updateAccount(accountId, '测试', 'alice@example.com', vault.encrypt({ ...accountConfig(), proxy: 'socks5://proxy-user:proxy-secret@127.0.0.1:1080' }), false);
  const settings = service.accountSettings(accountId);
  expect(JSON.stringify(settings)).not.toContain('test-password');
  expect(JSON.stringify(settings)).not.toContain('proxy-secret');
  expect(settings.proxyDisplay).toBe('socks5://127.0.0.1:1080');
  await service.updateAccount(accountId, accountUpdateSchema.parse({ ...settings, name: '新名称' }));
  await service.sync(accountId);
  const saved = vault.decrypt<ReturnType<typeof accountConfig>>(store.account(accountId)!.encryptedConfig);
  expect(saved.imap.password).toBe('test-password'); expect(saved.smtp.password).toBe('test-password');
  expect(saved.proxy).toContain('proxy-secret'); expect(saved.name).toBe('新名称');
  expect(store.message(messageId)).toBeDefined();
});

it('saves settings even when the next background IMAP connection fails', async () => {
  await service.sync(accountId);
  const candidate = serverAdapter();
  candidate.connect.mockRejectedValueOnce(new Error('bad IMAP credentials'));
  factory.mockImplementationOnce(() => candidate);
  await service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '离线保存' }));
  await service.sync(accountId);
  expect(store.account(accountId)?.name).toBe('离线保存');
  expect(candidate.verifySmtp).not.toHaveBeenCalled();
  expect(store.message(messageId)).toBeDefined(); expect(adapter.close).toHaveBeenCalledOnce();
});

it('checks unsaved receive and send settings independently without replacing stored settings or the active connection', async () => {
  await service.sync(accountId);
  const candidate = serverAdapter(); candidate.verifySmtp.mockRejectedValue(new Error('SMTP unavailable'));
  factory.mockImplementationOnce(() => candidate);
  const before = store.account(accountId)!.encryptedConfig;
  const result = await service.verifyAccountSettings(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '未保存名称', smtp: { ...service.accountSettings(accountId).smtp, port: 587 } }));
  expect(result).toMatchObject({ imap: { status: 'success' }, smtp: { status: 'error' } });
  expect(factory.mock.calls.at(-1)![0]).toMatchObject({ name: '未保存名称', smtp: { port: 587, password: 'test-password' } });
  expect(candidate.connect).toHaveBeenCalledOnce(); expect(candidate.verifySmtp).toHaveBeenCalledOnce(); expect(candidate.close).toHaveBeenCalledOnce();
  expect(store.account(accountId)?.encryptedConfig).toBe(before); expect(store.message(messageId)).toBeDefined();
  expect(adapter.close).not.toHaveBeenCalled();
});

it('persists consecutive saves while an old flag operation is stuck, then ignores its late acknowledgement', async () => {
  const entered = deferred(); const release = deferred();
  const replacement = serverAdapter();
  adapter.flags.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
  const marking = service.flags(messageId, { seen: true }).catch(error => error);
  await entered.promise;
  factory.mockImplementation(() => replacement);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const first = service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '第一次保存' }));
    expect(store.account(accountId)?.name).toBe('第一次保存');
    const second = service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '第二次保存' }));
    expect(store.account(accountId)?.name).toBe('第二次保存');
    await Promise.all([first, second]);
    expect((await marking).status).toBe(409);
    await service.sync(accountId);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[account-work]', expect.objectContaining({ phase: 'cleanup-timeout', pending: expect.arrayContaining(['flags']), elapsedMs: expect.any(Number) })));
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(store.message(messageId)?.seen).toBe(false);
    expect(store.account(accountId)?.name).toBe('第二次保存');
    expect(replacement.connect).toHaveBeenCalled();
  } finally { release.resolve(); warning.mockRestore(); }
});

it('switches after a bounded wait for an old sync and rejects late batches and status writes', async () => {
  const entered = deferred(); const release = deferred();
  adapter.sync.mockImplementationOnce(async (_folder, sink) => {
    entered.resolve(); await release.promise;
    sink.messages([record(99, { subject: '旧配置迟到的邮件' })]);
    throw new Error('旧同步错误');
  });
  const oldSync = service.sync(accountId);
  await entered.promise;
  const replacement = serverAdapter(); factory.mockImplementation(() => replacement);
  try {
    const saving = service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '新配置' }));
    expect(store.account(accountId)?.name).toBe('新配置'); await saving;
    await service.sync(accountId);
    release.resolve(); await oldSync; await new Promise(resolve => setImmediate(resolve));
    expect(store.folderUids(inbox.id)).toEqual([1]);
    expect(store.account(accountId)?.error).toBeNull();
    expect(replacement.sync).toHaveBeenCalled();
    expect(factory.mock.calls.at(-1)![0].name).toBe('新配置');
  } finally { release.resolve(); }
});

it('saves before a stuck prefetch close completes and starts fresh work without accepting the old body', async () => {
  const background = serverAdapter(); const replacement = serverAdapter();
  const entered = deferred(); const releaseFetch = deferred(); const releaseClose = deferred();
  background.bodyText.mockImplementation(async () => { entered.resolve(); await releaseFetch.promise; return '已取消的旧正文'; });
  background.close.mockImplementation(() => releaseClose.promise);
  factory.mockImplementationOnce(() => adapter).mockImplementationOnce(() => background).mockImplementation(() => replacement);
  service.start();
  await entered.promise;
  try {
    const saving = service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '不等待预取' }));
    expect(store.account(accountId)?.name).toBe('不等待预取'); await saving;
    await service.sync(accountId);
    await vi.waitFor(() => expect(store.message(messageId)?.preview).toBe('后台索引正文'));
    releaseFetch.resolve(); releaseClose.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(store.message(messageId)?.preview).toBe('后台索引正文');
    expect(replacement.connect).toHaveBeenCalled();
  } finally { releaseFetch.resolve(); releaseClose.resolve(); }
});

it('returns a verification timeout even when both protocols and close never finish', async () => {
  const release = deferred();
  adapter.connect.mockImplementation(() => release.promise);
  adapter.verifySmtp.mockImplementation(() => release.promise);
  adapter.close.mockImplementation(() => release.promise);
  const before = store.account(accountId)!.encryptedConfig;
  try {
    const result = await service.verifyAccountSettings(accountId, accountUpdateSchema.parse(service.accountSettings(accountId)));
    expect(result).toEqual({ imap: { status: 'error', error: '校验连接超时，请重试' }, smtp: { status: 'error', error: '校验连接超时，请重试' } });
    expect(store.account(accountId)?.encryptedConfig).toBe(before);
  } finally { release.resolve(); }
});

it('cancels a hung verification when saving without waiting for it or overwriting the saved settings', async () => {
  const release = deferred(); const replacement = serverAdapter();
  adapter.connect.mockImplementation(() => release.promise); adapter.verifySmtp.mockImplementation(() => release.promise);
  const checking = service.verifyAccountSettings(accountId, accountUpdateSchema.parse(service.accountSettings(accountId)));
  factory.mockImplementation(() => replacement);
  try {
    await service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '校验中保存' }));
    expect(store.account(accountId)?.name).toBe('校验中保存');
    const result = await checking;
    expect(result.imap).toMatchObject({ status: 'error', error: expect.stringContaining('设置已变更') });
    expect(result.smtp.status).toBe('error');
  } finally { release.resolve(); }
});

it('preserves SMTP acceptance after settings change without replaying or rewriting the draft', async () => {
  const draft = await service.saveDraft(undefined, draftSchema.parse({ accountId, subject: '正在发送', text: 'test' }));
  const entered = deferred(); const release = deferred();
  adapter.send.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { messageId: '<accepted>' }; });
  const sending = service.send(sendSchema.parse({ accountId, draftId: draft.id, to: ['bob@example.com'], subject: draft.subject, text: draft.text }));
  await entered.promise;
  const replacement = serverAdapter(); factory.mockImplementation(() => replacement);
  try {
    await service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: '发送中保存' }));
    release.resolve();
    const result = await sending;
    expect(result).toMatchObject({ messageId: '<accepted>', warning: expect.stringContaining('请勿重复发送') });
    expect(store.draft(draft.id)).toBeDefined();
    expect(adapter.send).toHaveBeenCalledOnce(); expect(replacement.send).not.toHaveBeenCalled();
  } finally { release.resolve(); }
});

it.each(['imap', 'smtp'] as const)('does not verify the disabled %s channel', async disabled => {
  const candidate = serverAdapter(); factory.mockImplementationOnce(() => candidate);
  const input = accountUpdateSchema.parse({ ...service.accountSettings(accountId), receiveEnabled: disabled !== 'imap', sendEnabled: disabled !== 'smtp' });
  const result = await service.verifyAccountSettings(accountId, input);
  expect(result[disabled].status).toBe('disabled');
  expect(result[disabled === 'imap' ? 'smtp' : 'imap'].status).toBe('success');
  expect(disabled === 'imap' ? candidate.connect : candidate.verifySmtp).not.toHaveBeenCalled();
});

it('rebuilds mailbox mappings after changing IMAP identity while retaining local drafts', async () => {
  const draft = await service.saveDraft(undefined, draftSchema.parse({ accountId, subject: '保留草稿', text: '' }));
  const settings = service.accountSettings(accountId);
  await service.updateAccount(accountId, accountUpdateSchema.parse({ ...settings, imap: { ...settings.imap, user: 'another@example.com' } }));
  await service.sync(accountId);
  expect(store.message(messageId)).toBeUndefined();
  expect(service.getDraft(draft.id).subject).toBe('保留草稿');
  expect(store.folders(accountId).find(folder => folder.path === 'INBOX')?.id).not.toBe(inbox.id);
});

it('saves a receiving account without verifying SMTP', async () => {
  const candidate = serverAdapter(); candidate.verifySmtp.mockRejectedValue(new Error('SMTP is unreachable'));
  factory.mockImplementationOnce(() => candidate);
  const id = await service.addAccount(accountConfig());
  expect(store.account(id)).toMatchObject({ receiveEnabled: true, sendEnabled: true });
  expect(candidate.verifySmtp).not.toHaveBeenCalled();
});

it('reconnects only inheriting accounts after a global proxy change', async () => {
  const vault = new Vault(Buffer.alloc(32));
  const customId = store.addAccount('独立代理', 'custom@example.com', vault.encrypt({ ...accountConfig(), email: 'custom@example.com', proxy: 'http://127.0.0.1:8001' }));
  const independent = serverAdapter(); const replacement = serverAdapter();
  factory.mockImplementationOnce(() => adapter).mockImplementationOnce(() => independent).mockImplementation(() => replacement);
  await service.sync(accountId); await service.sync(customId);
  const result = await service.setGlobalProxy('http://global:private@127.0.0.1:8002');
  await service.sync(accountId);
  expect(result.display).toBe('http://127.0.0.1:8002'); expect(JSON.stringify(result)).not.toContain('private');
  expect(adapter.close).toHaveBeenCalled(); expect(independent.close).not.toHaveBeenCalled();
  expect(factory.mock.calls.at(-1)![0].proxy).toBe('http://global:private@127.0.0.1:8002');
  expect(service.accountSettings(accountId)).toMatchObject({ proxyMode: 'global', globalProxyDisplay: 'http://127.0.0.1:8002' });
  expect(service.accountSettings(customId)).toMatchObject({ proxyMode: 'custom', proxyDisplay: 'http://127.0.0.1:8001' });
});

it('adds and sends from a send-only account without connecting to IMAP or syncing', async () => {
  const candidate = serverAdapter(); candidate.connect.mockRejectedValue(new Error('IMAP is unreachable'));
  factory.mockImplementationOnce(() => candidate);
  const id = await service.addAccount({ ...accountConfig(), receiveEnabled: false });
  await service.sync(id);
  await service.send(sendSchema.parse({ accountId: id, to: ['bob@example.com'], subject: 'send only', text: 'test' }));
  expect(candidate.verifySmtp).toHaveBeenCalledOnce(); expect(candidate.connect).not.toHaveBeenCalled();
  expect(candidate.sync).not.toHaveBeenCalled(); expect(candidate.watchInbox).not.toHaveBeenCalled();
  expect(candidate.send).toHaveBeenCalledOnce(); expect(store.folders(id)).toEqual([]);
});

it('rejects sending from a receive-only account before any SMTP operation', async () => {
  const candidate = serverAdapter(); factory.mockImplementationOnce(() => candidate);
  const id = await service.addAccount({ ...accountConfig(), sendEnabled: false });
  await expect(service.send(sendSchema.parse({ accountId: id, to: ['bob@example.com'], subject: 'receive only', text: 'test' }))).rejects.toThrow('关闭发信');
  expect(candidate.verifySmtp).not.toHaveBeenCalled(); expect(candidate.send).not.toHaveBeenCalled();
});

it('stops receiving after changing modes while keeping cached mail readable', async () => {
  await service.body(messageId); await service.sync(accountId);
  const candidate = serverAdapter(); factory.mockImplementationOnce(() => candidate);
  await service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), receiveEnabled: false }));
  await service.sync(accountId);
  expect(adapter.close).toHaveBeenCalledOnce(); expect(candidate.verifySmtp).not.toHaveBeenCalled();
  expect(candidate.connect).not.toHaveBeenCalled(); expect(candidate.sync).not.toHaveBeenCalled();
  expect(store.message(messageId)).toBeDefined(); expect((await service.body(messageId)).text).toContain('缓存正文');
  await expect(service.flags(messageId, { seen: true })).rejects.toThrow('关闭收信');
});

it('persists incomplete draft addresses and upload bytes, then removes only unreferenced files', async () => {
  const file = await service.uploads!.save('../../outside.txt', 'text/plain', Buffer.from('附件内容'));
  const saved = await service.saveDraft(undefined, draftSchema.parse({ accountId, to: '未写完@', subject: '', text: '', attachmentIds: [file.id] }));
  expect(service.getDraft(saved.id).to).toBe('未写完@');
  expect(service.getDraft(saved.id).attachments[0].filename).toBe('../../outside.txt');
  expect(await readdir(join(directory, 'uploads'))).toEqual([`${file.id}.bin`]);
  await service.uploads!.removeUnused([file.id]); expect(store.upload(file.id)).toBeDefined();
  await service.saveDraft(saved.id, { ...saved, attachmentIds: [] });
  expect(store.upload(file.id)).toBeUndefined(); expect(await readdir(join(directory, 'uploads'))).toEqual([]);
});

it('keeps a draft after SMTP failure and removes it only after acceptance', async () => {
  const file = await service.uploads!.save('合同.txt', 'text/plain', Buffer.from('合同附件'));
  const draft = await service.saveDraft(undefined, draftSchema.parse({ accountId, to: 'bob@example.com', subject: '合同', text: '见附件', attachmentIds: [file.id] }));
  const send = sendSchema.parse({ ...draft, to: ['bob@example.com'], cc: [], bcc: [], draftId: draft.id });
  adapter.send.mockRejectedValueOnce(new Error('SMTP rejected'));
  await expect(service.send(send)).rejects.toThrow('SMTP');
  expect(store.draft(draft.id)).toBeDefined(); expect(store.upload(file.id)).toBeDefined();
  await service.send(send);
  expect(adapter.send.mock.calls[1]?.[2]).toEqual([{ filename: '合同.txt', mimeType: 'text/plain', content: Buffer.from('合同附件') }]);
  expect(store.draft(draft.id)).toBeUndefined(); expect(store.upload(file.id)).toBeUndefined();
});

it('cleans expired orphan uploads without deleting draft attachments', async () => {
  const orphan = await service.uploads!.save('orphan.txt', 'text/plain', Buffer.from('old'));
  const kept = await service.uploads!.save('saved.txt', 'text/plain', Buffer.from('saved'));
  await service.saveDraft(undefined, draftSchema.parse({ accountId, text: '', subject: '', attachmentIds: [kept.id] }));
  store.sqlite.prepare('UPDATE uploads SET created_at = 0').run();
  await service.uploads!.cleanup();
  expect(store.upload(orphan.id)).toBeUndefined(); expect(store.upload(kept.id)).toBeDefined();
});

it('uses a separate background adapter so opening and marking mail do not wait for prefetch', async () => {
  const background = serverAdapter();
  const entered = deferred(); const release = deferred();
  background.bodyText.mockImplementation(async () => { entered.resolve(); await release.promise; return '后台正文'; });
  background.close.mockImplementation(async () => { release.resolve(); });
  factory.mockImplementationOnce(() => adapter).mockImplementation(() => background);
  service.start();
  try {
    await entered.promise;
    expect((await service.body(messageId)).text).toContain('缓存正文');
    await service.flags(messageId, { seen: true });
    expect(store.message(messageId)).toMatchObject({ seen: true, cached: true });
    expect(adapter.source).toHaveBeenCalledOnce();
    expect(adapter.flags).toHaveBeenCalledOnce();
    expect(background.source).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
  } finally { release.resolve(); await service.stop(); }
});

it('returns an old CID cache without waiting for an unavailable network', async () => {
  await legacyCidCache();
  let fail!: (error: Error) => void;
  adapter.source.mockImplementationOnce(() => new Promise<Buffer<ArrayBuffer>>((_, reject) => { fail = reject; }));
  try {
    expect((await service.body(messageId)).text).toBe('旧缓存正文');
    await vi.waitFor(() => expect(adapter.source).toHaveBeenCalledOnce());
  } finally { fail(new Error('offline')); }
});

it('upgrades an old CID cache once and tells the reader to refresh', async () => {
  await legacyCidCache();
  const source = await new MailComposer({ from: 'alice@example.com', to: 'bob@example.com', html: '<img src="cid:logo">',
    attachments: [{ filename: 'logo.png', content: Buffer.from('iVBORw0KGgo=', 'base64'), contentType: 'image/png', cid: 'logo' }] }).compile().build();
  adapter.source.mockResolvedValue(Buffer.from(source));
  const update = vi.fn(); service.events.on('update', update);
  expect((await service.body(messageId)).text).toBe('旧缓存正文');
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ type: 'change', accountId, messageId, contentOnly: true }));
  const upgraded = await service.body(messageId);
  expect(upgraded.inlineImages).toHaveLength(1);
  expect(await service.body(messageId)).toEqual(upgraded);
  expect(adapter.source).toHaveBeenCalledOnce();
});

it('serves cached raw source offline, coalesces uncached loads, and backfills legacy entries', async () => {
  const gate = deferred();
  const uncachedSource = Buffer.from('Subject: uncached\r\n\r\nfresh raw');
  adapter.source.mockImplementationOnce(async () => { await gate.promise; return uncachedSource; });
  const pending = Promise.all([service.raw(messageId), service.raw(messageId)]);
  gate.resolve();
  const [first, second] = await pending;
  expect(first).toEqual(uncachedSource);
  expect(second).toEqual(uncachedSource);
  expect(adapter.source).toHaveBeenCalledOnce();

  await service.cache.remove([messageId]);
  await legacyCidCache();
  const legacySource = Buffer.from('Subject: legacy\r\n\r\nbackfilled raw');
  adapter.source.mockResolvedValueOnce(legacySource);
  expect(await service.raw(messageId)).toEqual(legacySource);
  expect(adapter.source).toHaveBeenCalledTimes(2);
  expect(await service.cache.raw(messageId)).toEqual(legacySource);

  await service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), receiveEnabled: false }));
  expect(await service.raw(messageId)).toEqual(legacySource);
  expect(adapter.source).toHaveBeenCalledTimes(2);
});

async function legacyCidCache() {
  const target = join(directory, messageId);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'body.json'), JSON.stringify({ text: '旧缓存正文', html: '<img src="cid:logo">', attachments: [] }));
  store.cacheBody(messageId, '旧缓存正文');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function serverAdapter() {
  const stopWatch = vi.fn();
  return {
    connect: vi.fn(async () => {}), verifySmtp: vi.fn(async () => {}), close: vi.fn(async () => {}),
    listFolders: vi.fn(async () => [inbox, sent]),
    sync: vi.fn(async (folder: Folder, sink: SyncSink) => {
      sink.begin('1');
      return { cursor: { uidValidity: '1', uidNext: 2, modseq: null }, uids: folder.path === 'INBOX' ? [1] : [] };
    }),
    source: vi.fn(async () => Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n缓存正文')),
    bodyText: vi.fn(async () => '后台索引正文'),
    copyRecipients: vi.fn(async () => []),
    flags: vi.fn(async () => {}), move: vi.fn(async (): Promise<MoveReceipt> => ({ uid: 10, uidValidity: '1' })),
    markAllRead: vi.fn<MailAdapter['markAllRead']>(async () => ({ uidValidity: '1', uidNext: 2 })), createFolder: vi.fn<MailAdapter['createFolder']>(async name => name), deleteFolder: vi.fn<MailAdapter['deleteFolder']>(async () => {}),
    send: vi.fn<MailAdapter['send']>(async () => ({ messageId: '<sent>' })),
    watchInbox: vi.fn(async (onChange: () => void) => { notify = onChange; return stopWatch; }), stopWatch,
  };
}

it('never sends a saved password to a different server', async () => {
  const settings = service.accountSettings(accountId);
  const moved = accountUpdateSchema.parse({ ...settings, imap: { ...settings.imap, host: 'localhost' } });
  await expect(service.updateAccount(accountId, moved)).rejects.toThrow('重新填写密码');
  expect(factory).not.toHaveBeenCalledWith(expect.objectContaining({ imap: expect.objectContaining({ host: 'localhost' }) }), expect.anything());
});

it('keeps syncing the remaining folders when one folder fails', async () => {
  adapter.sync.mockImplementationOnce(async () => { throw new Error('这个文件夹暂时无法打开'); });
  await service.sync(accountId);
  expect(adapter.sync).toHaveBeenCalledTimes(2);
  // Once for the round, and once more because the failure may have cost the connection.
  expect(adapter.connect).toHaveBeenCalledTimes(2);
  expect(store.folders(accountId).filter(folder => folder.uidNext === 2)).toHaveLength(1);
  expect(store.account(accountId)?.error).toMatch(/^同步文件夹「.+」失败：这个文件夹暂时无法打开；其余文件夹已同步$/);
  expect(adapter.watchInbox).toHaveBeenCalledOnce();
  await service.sync(accountId);
  expect(store.account(accountId)?.error).toBeNull();
});

it('ends the round with the original failure when the connection cannot be reopened', async () => {
  adapter.sync.mockImplementationOnce(async () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); });
  adapter.connect.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); });
  await service.sync(accountId);
  expect(adapter.sync).toHaveBeenCalledOnce();
  expect(store.account(accountId)?.error).toMatch(/^同步文件夹「.+」失败：邮件服务器连接失败（ECONNRESET）/);
  expect(store.account(accountId)?.error).not.toContain('其余文件夹已同步');
});
