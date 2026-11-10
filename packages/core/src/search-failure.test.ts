import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { listSchema } from '@mail/shared';
import { accountConfig, database, record } from '../../../tests/fixtures';
import { ImapAdapter } from './imap';
import { MailService } from './service';
import { Vault } from './crypto';
import { BodyCache } from './cache';

let store: ReturnType<typeof database>;
let service: MailService;
let directory: string;
let accountId: string;
let folderId: string;
let ids: string[];

beforeEach(async () => {
  await mkdir('.test-artifacts', { recursive: true });
  directory = await mkdtemp(resolve('.test-artifacts/search-failure-'));
  store = database();
  const vault = new Vault(Buffer.alloc(32));
  accountId = store.addAccount('测试', 'alice@example.com', vault.encrypt(accountConfig()));
  const [folder] = store.saveFolders(accountId, [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }]);
  folderId = folder.id;
  store.beginFolder(folder.id, '1');
  store.applyBatch(store.folder(folder.id)!, [record(1), record(2), record(3)]);
  store.finishFolder(folder.id, { uidValidity: '1', uidNext: 4, modseq: '10' }, [1, 2, 3]);
  const cache = new BodyCache(directory);
  ids = store.list(listSchema.parse({})).messages.map(message => message.id);
  for (const id of ids) {
    const body = await cache.save(id, Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n离线合同正文'));
    store.cacheBody(id, body.text);
  }
  vi.spyOn(ImapAdapter.prototype, 'connect').mockResolvedValue();
  vi.spyOn(ImapAdapter.prototype, 'listFolders').mockResolvedValue([{ path: 'INBOX', name: 'INBOX', role: 'inbox' }]);
  vi.spyOn(ImapAdapter.prototype, 'watchInbox').mockResolvedValue(() => {});
  service = new MailService(store, vault, cache);
});

afterEach(async () => {
  await service.stop(); store.close(); vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  { response: false as const, validity: 1n },
  { response: false as const, validity: 2n },
  { response: [] as number[], validity: 1n },
  { response: [] as number[], validity: 2n },
])('keeps local mail and cursors when SEARCH returns $response with UIDVALIDITY $validity', async ({ response, validity }) => {
  mockMailbox(validity, 3);
  vi.spyOn(ImapFlow.prototype, 'search').mockResolvedValue(response);
  const before = snapshot();
  await service.sync(accountId);
  expect(snapshot()).toEqual(before);
  expect(store.account(accountId)?.error).toContain('SEARCH');
  expect(store.list(listSchema.parse({ q: '合同' })).total).toBe(3);
  for (const id of ids) expect((await service.body(id)).text).toContain('离线合同正文');
});

it('still reconciles deletions when SEARCH succeeds and the mailbox really is empty', async () => {
  mockMailbox(1n, 0);
  vi.spyOn(ImapFlow.prototype, 'search').mockResolvedValue([]);
  await service.sync(accountId);
  expect(store.account(accountId)?.error).toBeNull();
  expect(store.folderUids(folderId)).toEqual([]);
  expect(store.list(listSchema.parse({ q: '合同' })).total).toBe(0);
});

function mockMailbox(uidValidity: bigint, exists: number) {
  vi.spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (this: ImapFlow) {
    this.mailbox = { path: 'INBOX', delimiter: '/', flags: new Set(), uidValidity, uidNext: 4, exists, highestModseq: 20n };
    return { path: 'INBOX', release() {} };
  });
}

function snapshot() {
  return {
    folder: store.folder(folderId),
    messages: store.sqlite.prepare('SELECT * FROM messages ORDER BY id').all(),
    locations: store.sqlite.prepare('SELECT * FROM locations ORDER BY uid').all(),
    search: store.sqlite.prepare('SELECT rowid, * FROM message_search ORDER BY rowid').all(),
    searchRows: store.sqlite.prepare('SELECT * FROM message_search_rows ORDER BY id').all(),
  };
}
