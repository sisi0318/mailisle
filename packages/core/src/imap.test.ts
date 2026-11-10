import { afterEach, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapAdapter } from './imap';
import { accountConfig } from '../../../tests/fixtures';
import type { Folder } from '@mail/shared';

afterEach(() => vi.restoreAllMocks());

it.each(['\\NoSelect', '\\Noselect', '\\NOSELECT'])('skips %s containers while keeping their selectable children', async noSelect => {
  vi.spyOn(ImapFlow.prototype, 'list').mockResolvedValue([
    { path: 'INBOX', pathAsListed: 'INBOX', name: 'INBOX', delimiter: '/', parent: [], parentPath: '', flags: new Set(['\\HasNoChildren']), listed: true, subscribed: true },
    { path: '其他文件夹', pathAsListed: '其他文件夹', name: '其他文件夹', delimiter: '/', parent: [], parentPath: '', flags: new Set([noSelect, '\\HasChildren']), listed: true, subscribed: false },
    { path: '其他文件夹/QQ邮件订阅', pathAsListed: '其他文件夹/QQ邮件订阅', name: 'QQ邮件订阅', delimiter: '/', parent: ['其他文件夹'], parentPath: '其他文件夹', flags: new Set(['\\HasNoChildren']), listed: true, subscribed: true },
    { path: 'Work', pathAsListed: 'Work', name: 'Work', delimiter: '/', parent: [], parentPath: '', flags: new Set(['\\HasChildren']), listed: true, subscribed: true },
  ]);
  const adapter = new ImapAdapter(accountConfig());
  try {
    expect(await adapter.listFolders()).toEqual([
      { path: 'INBOX', name: 'INBOX', role: 'inbox' },
      { path: '其他文件夹/QQ邮件订阅', name: 'QQ邮件订阅', role: 'other' },
      { path: 'Work', name: 'Work', role: 'other' },
    ]);
  } finally { await adapter.close(); }
});

it('uses CONDSTORE only for known message flags and keeps the initial MODSEQ checkpoint', async () => {
  let opens = 0;
  vi.spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (this: ImapFlow) {
    this.mailbox = { path: 'INBOX', delimiter: '/', flags: new Set(), uidValidity: 1n, uidNext: 4, exists: 2, highestModseq: BigInt(20 + opens++) };
    return { path: 'INBOX', release() {} };
  });
  vi.spyOn(ImapFlow.prototype, 'search').mockResolvedValue([2, 3]);
  const fetch = vi.spyOn(ImapFlow.prototype, 'fetchAll').mockResolvedValue([]);
  const adapter = new ImapAdapter(accountConfig());
  const folder: Folder = { id: 'inbox', accountId: 'account', path: 'INBOX', name: 'INBOX', role: 'inbox', uidValidity: '1', uidNext: 3, modseq: '10' };
  try {
    const result = await adapter.sync(folder, { knownUids: [2], begin() {}, messages() {}, flags() {} });
    expect(fetch.mock.calls[0][0]).toEqual([3]);
    expect(fetch.mock.calls[0][1].envelope).toBe(true);
    expect(fetch.mock.calls[0][2]).toEqual({ uid: true });
    expect(fetch.mock.calls[1]).toEqual([[2], { uid: true, flags: true }, { uid: true, changedSince: 10n }]);
    expect(result.cursor.modseq).toBe('20');
  } finally { await adapter.close(); }
});

it('refetches envelopes after UIDVALIDITY changes even when the same UID numbers were cached', async () => {
  vi.spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (this: ImapFlow) {
    this.mailbox = { path: 'INBOX', delimiter: '/', flags: new Set(), uidValidity: 2n, uidNext: 3, exists: 2, highestModseq: 20n };
    return { path: 'INBOX', release() {} };
  });
  vi.spyOn(ImapFlow.prototype, 'search').mockResolvedValue([1, 2]);
  const fetch = vi.spyOn(ImapFlow.prototype, 'fetchAll').mockResolvedValue([]);
  const begin = vi.fn();
  const adapter = new ImapAdapter(accountConfig());
  try {
    await adapter.sync({ id: 'inbox', accountId: 'account', path: 'INBOX', name: 'INBOX', role: 'inbox', uidValidity: '1', uidNext: 3, modseq: '10' },
      { knownUids: [1, 2], begin, messages() {}, flags() {} });
    expect(begin).toHaveBeenCalledWith('2');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toEqual([1, 2]);
    expect(fetch.mock.calls[0][1].envelope).toBe(true);
    expect(fetch.mock.calls[0][2]).toEqual({ uid: true });
  } finally { await adapter.close(); }
});
