import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Folder, MoveReceipt } from '@mail/shared';
import { accountConfig, database, record } from '../../../tests/fixtures';
import { BodyCache } from './cache';
import { Vault } from './crypto';
import { MailService } from './service';
import type { MailAdapter, SyncSink } from './adapter';

let store: ReturnType<typeof database>;
let directory: string;
let service: MailService;
let accountId: string;
let inbox: Folder;
let sent: Folder;
let messageId: string;
let notify: () => void;
let adapter: ReturnType<typeof serverAdapter>;
let factory: ReturnType<typeof vi.fn<(config: ReturnType<typeof accountConfig>) => MailAdapter>>;

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
  service = new MailService(store, vault, new BodyCache(directory), factory);
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
    flags: vi.fn(async () => {}), move: vi.fn(async (): Promise<MoveReceipt> => ({ uid: 10, uidValidity: '1' })),
    send: vi.fn(async () => ({ messageId: '<sent>' })),
    watchInbox: vi.fn(async (onChange: () => void) => { notify = onChange; return stopWatch; }), stopWatch,
  };
}
