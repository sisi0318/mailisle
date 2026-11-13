import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { BodyCache } from './cache';

let directory: string;
beforeEach(async () => { await mkdir('.test-artifacts', { recursive: true }); directory = await mkdtemp(resolve('.test-artifacts/mail-cache-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('decodes GB18030 mail and stores binary attachments under generated filenames', async () => {
  const source = Buffer.from([
    'From: sender@example.com', 'To: alice@example.com', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test"', '',
    '--test', 'Content-Type: text/plain; charset=gb18030', 'Content-Transfer-Encoding: base64', '', '1tDOxA==',
    '--test', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="../../outside.bin"', 'Content-Transfer-Encoding: base64', '', 'AAECA/8=', '--test--', '',
  ].join('\r\n'));
  const cache = new BodyCache(directory);
  expect(await cache.read('message-1')).toBeNull();
  expect(await cache.raw('message-1')).toBeNull();
  const body = await cache.save('message-1', source);
  expect(body.text.trim()).toBe('中文');
  expect(body.attachments[0].size).toBe(5);
  expect(await cache.attachment('message-1', '0')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  expect(await cache.raw('message-1')).toEqual(source);
  expect(await new BodyCache(directory).read('message-1')).toEqual(body);
});

it('backfills raw RFC 822 source independently for legacy cache entries', async () => {
  const cache = new BodyCache(directory);
  const raw = Buffer.from('Subject: legacy\r\n\r\nhello');
  await cache.saveRaw('legacy-1', raw);
  expect(await cache.raw('legacy-1')).toEqual(raw);
});

it('extracts searchable text from HTML-only mail without including scripts or styles', async () => {
  const source = Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n<style>body {color:red}</style><p>电子发票 &amp; 合同</p><script>tracking()</script>');
  const body = await new BodyCache(directory).save('html-only', source);
  expect(body.text).toContain('电子发票 & 合同');
  expect(body.text).not.toContain('tracking');
  expect(body.text).not.toContain('color:red');
});

it('keeps CID metadata on disk and supplies only raster images as data URLs', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5kAAAAASUVORK5CYII=', 'base64');
  const source = await new MailComposer({ from: 'alice@example.com', to: 'bob@example.com',
    html: '<img src="cid:logo@example.com"><img src="cid:vector@example.com">',
    attachments: [
      { filename: 'logo.png', content: png, contentType: 'image/png', cid: 'logo@example.com' },
      { filename: 'vector.svg', content: '<svg></svg>', contentType: 'image/svg+xml', cid: 'vector@example.com' },
    ] }).compile().build();
  const cache = new BodyCache(directory);
  const body = await cache.save('cid-message', source);
  expect(body.inlineImages).toEqual([{ attachmentId: '0', contentId: 'logo@example.com', dataUrl: `data:image/png;base64,${png.toString('base64')}` }]);
  expect(body.attachments[1].contentId).toBe('vector@example.com');
  expect(await new BodyCache(directory).read('cid-message')).toEqual(body);
  const stored = JSON.parse(await readFile(join(directory, 'cid-message', 'body.json'), 'utf8'));
  expect(stored.cacheVersion).toBe(2);
  expect(stored).not.toHaveProperty('inlineImages');
  expect(await cache.attachment('cid-message', '0')).toEqual(png);
});

it('removes cached mail whose message is gone and leaves everything else in the directory alone', async () => {
  const cache = new BodyCache(directory);
  const kept = '11111111-1111-4111-8111-111111111111';
  const gone = '22222222-2222-4222-8222-222222222222';
  const source = Buffer.from('Content-Type: text/plain\r\n\r\nhello');
  await cache.save(kept, source); await cache.save(gone, source);
  await mkdir(join(directory, 'uploads')); await writeFile(join(directory, 'uploads', 'file.bin'), 'x');
  await writeFile(join(directory, '33333333-3333-4333-8333-333333333333'), 'a file, not a cache entry');
  expect(await cache.sweep(id => id === kept)).toBe(1);
  expect(await cache.read(kept)).not.toBeNull();
  expect(await cache.read(gone)).toBeNull();
  expect(await readFile(join(directory, 'uploads', 'file.bin'), 'utf8')).toBe('x');
  expect(await readFile(join(directory, '33333333-3333-4333-8333-333333333333'), 'utf8')).toContain('not a cache entry');
  await cache.remove([kept, '../outside', 'uploads/..']);
  expect(await cache.read(kept)).toBeNull();
  expect(await readFile(join(directory, 'uploads', 'file.bin'), 'utf8')).toBe('x');
  expect(await new BodyCache(join(directory, 'missing')).sweep(() => false)).toBe(0);
});

it('refuses IDs that would leave the cache directory and re-fetches a damaged entry', async () => {
  const cache = new BodyCache(directory);
  await expect(cache.read('../outside')).rejects.toThrow('邮件不存在');
  await expect(cache.raw('../outside')).rejects.toThrow('邮件不存在');
  await expect(cache.attachment('message-1', '../../secret')).rejects.toThrow('附件不存在');
  await mkdir(join(directory, 'damaged')); await writeFile(join(directory, 'damaged', 'body.json'), '{"text":');
  expect(await cache.read('damaged')).toBeNull();
});
