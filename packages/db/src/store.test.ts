import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from './index';
import { listSchema } from '@mail/shared';
import { database, migrations, record, seedAccount } from '../../../tests/fixtures';

describe('SQLite mail store', () => {
  let store: MailStore;
  beforeEach(() => { store = database(); });
  afterEach(() => store.close());
  const query = (q = '', view: 'inbox' | 'all' | 'starred' = 'inbox') => listSchema.parse({ q, view });

  it('replays a batch without duplicating messages and indexes Chinese phrases and single characters', () => {
    const { inbox } = seedAccount(store);
    store.applyBatch(inbox, [record()]);
    store.applyBatch(inbox, [record()]);
    expect(store.list(query()).total).toBe(1);
    for (const text of ['发票', '电子发票', '合同', '票', 'billing@example.com']) expect(store.list(query(text)).total).toBe(1);
    for (const text of ['合同发票', '%', '" OR *', '并不存在']) expect(store.list(query(text)).total).toBe(0);
    const message = store.list(query()).messages[0];
    store.cacheBody(message.id, '本月报销单据请于周五提交。');
    expect(store.list(query('报销')).messages[0].cached).toBe(true);
    expect(store.message(message.id)?.preview).toContain('报销');
  });
  it('deduplicates provider IDs across folders and keeps other labels when one location disappears', () => {
    const { inbox, sent } = seedAccount(store);
    store.applyBatch(inbox, [record(1, { remoteId: 'gmail-123' })]);
    store.applyBatch(sent, [record(99, { remoteId: 'gmail-123', flags: ['\\Seen', '\\Flagged'] })]);
    expect(store.list(query('', 'all')).total).toBe(1);
    expect(store.list(query('', 'starred')).total).toBe(1);
    expect(store.list(query()).messages[0].seen).toBe(true);
    store.finishFolder(inbox.id, { uidValidity: '1', uidNext: 2, modseq: null }, []);
    expect(store.list(query()).total).toBe(0);
    expect(store.list(query('', 'all')).total).toBe(1);
    store.finishFolder(sent.id, { uidValidity: '1', uidNext: 100, modseq: null }, []);
    expect(store.list(query('发票', 'all')).total).toBe(0);
  });
  it('replaces old UID mappings on UIDVALIDITY change', () => {
    const { inbox } = seedAccount(store);
    store.applyBatch(inbox, [record(1)]);
    const oldId = store.list(query()).messages[0].id;
    store.beginFolder(inbox.id, '2');
    store.applyBatch(store.folder(inbox.id)!, [record(1, { subject: '新邮件' })]);
    store.finishFolder(inbox.id, { uidValidity: '2', uidNext: 2, modseq: '20' }, [1]);
    expect(store.message(oldId)).toBeUndefined();
    expect(store.list(query()).messages[0].subject).toBe('新邮件');
  });
  it('merges out-of-order reply chains without joining accounts', () => {
    const { inbox } = seedAccount(store);
    store.applyBatch(inbox, [record(3, { messageId: '<child>', references: ['<parent>'] }), record(1, { messageId: '<root>' })]);
    store.applyBatch(inbox, [record(2, { messageId: '<parent>', references: ['<root>'] })]);
    const messages = store.list(query()).messages;
    expect(new Set(messages.map(message => message.threadId)).size).toBe(1);
    const second = seedAccount(store, 'bob@example.com');
    store.applyBatch(second.inbox, [record(1, { messageId: '<root>' })]);
    expect(store.thread(messages[0].threadId)).toHaveLength(3);
  });
  it('persists committed batches but only advances the cursor when a folder finishes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mail-db-'));
    const filename = join(directory, 'mail.sqlite');
    const disk = new MailStore(filename, migrations);
    const { inbox } = seedAccount(disk);
    disk.applyBatch(inbox, [record()]);
    disk.close();
    const reopened = new MailStore(filename, migrations);
    try {
      expect(reopened.folder(inbox.id)?.uidNext).toBe(1);
      reopened.applyBatch(inbox, [record()]);
      reopened.finishFolder(inbox.id, { uidValidity: '1', uidNext: 2, modseq: null }, [1]);
      expect(reopened.list(query()).total).toBe(1);
      expect(reopened.folder(inbox.id)?.uidNext).toBe(2);
    } finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('paginates deterministically and scopes folders, accounts and cached body searches', () => {
    const first = seedAccount(store);
    const second = seedAccount(store, 'bob@example.com');
    store.applyBatch(first.inbox, [record(1), record(2)]);
    store.applyBatch(second.sent, [record(3)]);
    const page = store.list(listSchema.parse({ limit: 1 }));
    expect(page.total).toBe(2); expect(page.nextOffset).toBe(1);
    expect(store.list(listSchema.parse({ limit: 1, offset: 1 })).messages[0].id).not.toBe(page.messages[0].id);
    expect(store.list(listSchema.parse({ folderId: second.sent.id })).total).toBe(1);
    expect(store.list(listSchema.parse({ q: '发票' })).total).toBe(3);
    store.deleteAccount(second.accountId);
    expect(store.list(listSchema.parse({ q: '发票' })).total).toBe(2);
  });

  it('updates only changed flags without rewriting metadata or the search index', () => {
    const { inbox } = seedAccount(store);
    store.applyBatch(inbox, [record(1, { flags: ['\\Answered'] })]);
    const message = store.list(query()).messages[0];
    store.cacheBody(message.id, '离线合同正文');
    const indexBefore = store.sqlite.prepare('SELECT rowid, * FROM message_search').all();
    expect(store.applyFlags(inbox.id, [{ uid: 1, flags: ['\\Seen', '\\Answered'] }])).toBe(1);
    expect(store.applyFlags(inbox.id, [{ uid: 1, flags: ['\\Answered', '\\Seen'] }])).toBe(0);
    expect(store.message(message.id)).toMatchObject({ seen: true, cached: true, preview: '离线合同正文' });
    expect(store.sqlite.prepare('SELECT rowid, * FROM message_search').all()).toEqual(indexBefore);
    store.patchFlags(inbox.id, 1, { seen: false, starred: true });
    expect(store.messageLocations(message.id)[0].flags).toEqual(['\\Answered', '\\Flagged']);
  });

  it('keeps message identity, body cache and search index when a move returns UIDPLUS mapping', () => {
    const { inbox, sent } = seedAccount(store);
    store.applyBatch(inbox, [record()]);
    const message = store.list(query()).messages[0];
    store.cacheBody(message.id, '移动后仍可离线读取');
    expect(store.moveLocation(inbox.id, 1, sent, { uid: 9, uidValidity: '1' })).toBe(true);
    // The destination scan started before the move allocated UID 9.
    store.finishFolder(sent.id, { uidValidity: '1', uidNext: 2, modseq: null }, []);
    expect(store.list(query()).total).toBe(0);
    expect(store.messageLocations(message.id)).toMatchObject([{ uid: 9, folder: { id: sent.id } }]);
    store.applyBatch(sent, [record(9, { messageId: '<1@example.com>' })]);
    expect(store.list(query('', 'all')).total).toBe(1);
    expect(store.message(message.id)).toMatchObject({ cached: true, preview: '移动后仍可离线读取', threadId: message.threadId });
    expect(store.list(query('离线')).total).toBe(1);
  });

  it('removes a moved source immediately when UID mapping is unavailable', () => {
    const { inbox, sent } = seedAccount(store);
    store.applyBatch(inbox, [record()]);
    expect(store.moveLocation(inbox.id, 1, sent, {})).toBe(false);
    expect(store.list(query()).total).toBe(0);
    expect(store.sqlite.prepare('SELECT count(*) AS n FROM message_search').get()).toEqual({ n: 0 });
  });

  it('looks up thread anchors and search row IDs through indexes', () => {
    const { inbox, accountId } = seedAccount(store);
    store.applyBatch(inbox, [record()]);
    const anchorPlan = store.sqlite.prepare('EXPLAIN QUERY PLAN SELECT thread_id FROM thread_keys WHERE account_id = ? AND reference IN (?)').all(accountId, '<1@example.com>') as { detail: string }[];
    expect(anchorPlan.some(row => /SEARCH.*INDEX/.test(row.detail))).toBe(true);
    const searchPlan = store.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM message_search WHERE rowid = ?').all(1) as { detail: string }[];
    expect(searchPlan.some(row => row.detail.includes('INDEX 0:='))).toBe(true);
    store.deleteAccount(accountId);
    expect(store.sqlite.prepare('SELECT count(*) AS n FROM thread_keys').get()).toEqual({ n: 0 });
    expect(store.sqlite.prepare('SELECT count(*) AS n FROM message_search_rows').get()).toEqual({ n: 0 });
  });
});
