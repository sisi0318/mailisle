import { expect, it } from 'vitest';
import type { Folder } from '../packages/shared/src/index';
import { folderTree, splitFileName } from '../apps/web/src/format';

function folder(path: string, delimiter: string | null = '/', accountId = 'one'): Folder {
  return { id: `${accountId}:${path}`, accountId, path, delimiter, name: delimiter ? path.split(delimiter).at(-1)! : path,
    role: path === 'INBOX' ? 'inbox' : 'other', uidValidity: '', uidNext: 1, modseq: null };
}
it('groups QQ folders under a missing non-selectable parent and preserves full action paths', () => {
  const tree = folderTree([folder('其他文件夹/发票'), folder('其他文件夹/重要'), folder('INBOX')]);
  expect(tree.map(node => node.label)).toEqual(['收件箱', '其他文件夹']);
  expect(tree[1].folder).toBeUndefined();
  expect(tree[1].children.map(node => node.label)).toEqual(['发票', '重要']);
  expect(tree[1].children[0].folder?.path).toBe('其他文件夹/发票');
});
it('merges real parents with their descendants and uses each server delimiter without mixing accounts', () => {
  const tree = folderTree([folder('Work.2026.Invoices', '.'), folder('Work', '.'), folder('Work.2026', '.'), folder('Work/Receipts', '/', 'two'), folder('a/b', null)]);
  const parent = tree.find(node => node.path === 'Work' && node.accountId === 'one')!;
  expect(parent.folder?.id).toBe('one:Work');
  expect(parent.children[0].label).toBe('2026');
  expect(parent.children[0].children[0].label).toBe('Invoices');
  expect(tree.find(node => node.accountId === 'two')?.children[0].label).toBe('Receipts');
  expect(tree.find(node => node.path === 'a/b')?.children).toEqual([]);
});

it('keeps extensions un-truncated when splitting file names', () => {
  expect(splitFileName('2026-annual-financial-report.final.pdf')).toEqual({
    stem: '2026-annual-financial-report.final',
    ext: '.pdf',
  });
  expect(splitFileName('README')).toEqual({ stem: 'README', ext: '' });
  expect(splitFileName('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
  expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
});
