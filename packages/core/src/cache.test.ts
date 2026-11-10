import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  const body = await cache.save('message-1', source);
  expect(body.text.trim()).toBe('中文');
  expect(body.attachments[0].size).toBe(5);
  expect(await cache.attachment('message-1', '0')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  expect(await new BodyCache(directory).read('message-1')).toEqual(body);
});

it('extracts searchable text from HTML-only mail without including scripts or styles', async () => {
  const source = Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n<style>body {color:red}</style><p>电子发票 &amp; 合同</p><script>tracking()</script>');
  const body = await new BodyCache(directory).save('html-only', source);
  expect(body.text).toContain('电子发票 & 合同');
  expect(body.text).not.toContain('tracking');
  expect(body.text).not.toContain('color:red');
});
