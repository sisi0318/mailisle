import { afterEach, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapAdapter } from './imap';
import { accountConfig } from '../../../tests/fixtures';

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
