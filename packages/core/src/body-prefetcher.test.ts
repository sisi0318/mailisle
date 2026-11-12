import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listSchema } from '@mail/shared';
import { database, record, seedAccount } from '../../../tests/fixtures';
import { BodyCache } from './cache';
import { BodyPrefetcher } from './body-prefetcher';
import type { MailAdapter } from './adapter';

let store: ReturnType<typeof database>;
let seeded: ReturnType<typeof seedAccount>;
let directory: string;
let worker: BodyPrefetcher;
let text: ReturnType<typeof vi.fn<MailAdapter['bodyText']>>;
let close: ReturnType<typeof vi.fn<MailAdapter['close']>>;
let source: ReturnType<typeof vi.fn<MailAdapter['source']>>;
let create: ReturnType<typeof vi.fn<() => MailAdapter>>;
let events: { change: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  await mkdir('.test-artifacts', { recursive: true });
  directory = await mkdtemp(resolve('.test-artifacts/prefetch-'));
  store = database(); seeded = seedAccount(store);
  text = vi.fn(async (_folder, uid) => `后台合同正文 ${uid}`);
  close = vi.fn(async () => {});
  source = vi.fn();
  create = vi.fn(() => ({ connect: vi.fn(async () => {}), close, bodyText: text, source, copyRecipients: vi.fn(),
    verifySmtp: vi.fn(), listFolders: vi.fn(), sync: vi.fn(), flags: vi.fn(), markAllRead: vi.fn(), createFolder: vi.fn(), move: vi.fn(), send: vi.fn(), watchInbox: vi.fn(),
  }));
  events = { change: vi.fn(), error: vi.fn() };
  worker = new BodyPrefetcher(store, new BodyCache(directory), create, events);
  worker.start();
});
afterEach(async () => { await worker.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });

it('indexes unopened mail in newest-first batches and skips completed work on later passes', async () => {
  store.applyBatch(seeded.inbox, Array.from({ length: 45 }, (_, i) => record(i + 1)));
  await worker.schedule(seeded.accountId);
  expect(text.mock.calls.map(([, uid]) => uid)).toEqual(Array.from({ length: 45 }, (_, i) => 45 - i));
  expect(store.pendingBodies(seeded.accountId)).toEqual([]);
  expect(store.list(listSchema.parse({ q: '后台合同' })).total).toBe(45);
  expect(store.list(listSchema.parse({})).messages.every(message => !message.cached)).toBe(true);
  expect(events.change).toHaveBeenCalledTimes(3);
  await worker.schedule(seeded.accountId);
  expect(create).toHaveBeenCalledOnce();
  expect(source).not.toHaveBeenCalled();
});

it('passes over a failed message and retries it on the next scheduled pass', async () => {
  store.applyBatch(seeded.inbox, [record(1), record(2), record(3)]);
  text.mockImplementationOnce(async () => { throw Object.assign(new Error('该封正文编码暂不可读'), { code: 'ERR_ENCODING_NOT_SUPPORTED' }); });
  await worker.schedule(seeded.accountId);
  expect(store.pendingBodies(seeded.accountId)).toHaveLength(1);
  expect(events.error).toHaveBeenCalledOnce();
  expect(store.list(listSchema.parse({ q: '后台合同' })).total).toBe(2);
  await worker.schedule(seeded.accountId);
  expect(store.pendingBodies(seeded.accountId)).toEqual([]);
});

it('picks up new mail added while prefetching without creating another worker', async () => {
  store.applyBatch(seeded.inbox, [record(1), record(2)]);
  const entered = deferred(); const release = deferred();
  text.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return '较早的正文'; });
  const first = worker.schedule(seeded.accountId);
  await entered.promise;
  store.applyBatch(seeded.inbox, [record(3)]);
  expect(worker.schedule(seeded.accountId)).toBe(first);
  release.resolve(); await first;
  expect(create).toHaveBeenCalledOnce();
  expect(store.pendingBodies(seeded.accountId)).toEqual([]);
});

it('cancels an in-flight fetch without committing it and resumes unfinished work later', async () => {
  store.applyBatch(seeded.inbox, [record()]);
  const entered = deferred(); const release = deferred();
  text.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return '取消后的结果'; });
  close.mockImplementation(async () => { release.resolve(); });
  const work = worker.schedule(seeded.accountId);
  await entered.promise; await worker.stop(); await work;
  expect(store.pendingBodies(seeded.accountId)).toHaveLength(1);
  expect(events.change).not.toHaveBeenCalled();
  worker.start(); await worker.schedule(seeded.accountId);
  expect(store.pendingBodies(seeded.accountId)).toEqual([]);
});

it('does not overwrite a full body loaded by the reader during prefetch', async () => {
  store.applyBatch(seeded.inbox, [record()]);
  const id = store.pendingBodies(seeded.accountId)[0].id;
  const entered = deferred(); const release = deferred();
  text.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return '后台较早的结果'; });
  const work = worker.schedule(seeded.accountId);
  await entered.promise;
  store.cacheBody(id, '前台完整正文');
  release.resolve(); await work;
  expect(store.message(id)).toMatchObject({ preview: '前台完整正文', cached: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
