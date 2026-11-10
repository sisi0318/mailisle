import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Folder } from '@mail/shared';
import { accountConfig } from '../../../tests/fixtures';
import { ImapAdapter } from './imap';

const config = accountConfig();
const path = `faults-${randomUUID()}`;
let direct: ImapFlow;
let folder: Folder;
let uids: number[];
let proxy: Awaited<ReturnType<typeof faultProxy>>;
let adapter: ImapAdapter;

beforeAll(async () => {
  direct = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, doSTARTTLS: false,
    auth: { user: config.imap.user, pass: config.imap.password }, logger: false });
  direct.on('error', () => {});
  await direct.connect();
  await direct.mailboxCreate(path);
  const source = await new MailComposer({ from: config.email, to: config.email, subject: '故障回归', text: 'silent-link fixture' }).compile().build();
  for (let i = 0; i < 3; i++) await direct.append(path, source);
  const mailbox = await direct.mailboxOpen(path);
  if (!mailbox) throw new Error('Test mailbox did not open');
  const found = await direct.search({ all: true }, { uid: true });
  if (found === false) throw new Error('Test setup SEARCH failed');
  uids = found;
  folder = { id: path, accountId: 'test', name: path, path, role: 'other',
    uidValidity: mailbox.uidValidity.toString(), uidNext: mailbox.uidNext, modseq: null };
});
beforeEach(async () => {
  proxy = await faultProxy();
  adapter = new ImapAdapter({ ...config, imap: { ...config.imap, port: proxy.port } });
  await adapter.connect();
});
afterEach(async () => { await adapter?.close(); await proxy?.close(); });
afterAll(async () => {
  try { await direct?.mailboxDelete(path); }
  finally { direct?.close(); }
});

it.each(['NO', 'BAD', 'empty'] as const)('rejects a real SEARCH %s response before starting local reconciliation', async fault => {
  proxy.setFault(fault);
  const sink = { knownUids: uids, begin: vi.fn(), messages: vi.fn(), flags: vi.fn() };
  await expect(adapter.sync(folder, sink)).rejects.toThrow('SEARCH');
  expect(sink.begin).not.toHaveBeenCalled();
  expect(sink.messages).not.toHaveBeenCalled();
  expect(sink.flags).not.toHaveBeenCalled();
});

it('releases queued operations after a silent-link timeout and reconnects on the next request', async () => {
  await adapter.source(folder, uids[0]);
  proxy.setFault('blackhole');
  const start = performance.now();
  const pending = Promise.allSettled([
    adapter.flags(folder, uids[0], { seen: true }),
    adapter.source(folder, uids[0]),
  ]);
  let deadline: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Operations remained blocked after 110 seconds')), 110_000); }),
    ]);
    const elapsedMs = performance.now() - start;
    expect(result.map(item => item.status)).toEqual(['rejected', 'rejected']);
    expect(elapsedMs).toBeGreaterThanOrEqual(85_000);
    expect(elapsedMs).toBeLessThan(110_000);
    expect(proxy.connections).toBe(1);
    console.info(`Silent-link operations failed after ${Math.round(elapsedMs)} ms`);
    proxy.setFault('none');
    await adapter.connect();
    expect((await adapter.source(folder, uids[0])).toString()).toContain('silent-link fixture');
    expect(proxy.connections).toBe(2);
    const remote = await direct.fetchOne(uids[0], { flags: true }, { uid: true });
    expect(remote && remote.flags?.has('\\Seen')).toBe(false);
  } finally {
    clearTimeout(deadline!);
    await adapter.close();
    await pending;
  }
}, 120_000);

// Injects SEARCH replies or discards traffic without closing either TCP socket.
async function faultProxy() {
  let fault: 'none' | 'NO' | 'BAD' | 'empty' | 'blackhole' = 'none';
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer(client => {
    connections++;
    const upstream = createConnection({ host: '127.0.0.1', port: 3143 });
    sockets.add(client); sockets.add(upstream);
    let pending = Buffer.alloc(0);
    client.on('data', data => {
      if (fault === 'blackhole') return;
      if (fault === 'none') { upstream.write(data); return; }
      pending = Buffer.concat([pending, data]);
      let end: number;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.subarray(0, end + 2);
        pending = pending.subarray(end + 2);
        const search = /^(\S+) UID SEARCH\b/.exec(line.toString('ascii'));
        if (search) client.write(fault === 'empty' ? `* SEARCH\r\n${search[1]} OK SEARCH completed\r\n` : `${search[1]} ${fault} SEARCH rejected for test\r\n`);
        else upstream.write(line);
      }
    });
    upstream.on('data', data => { if (fault !== 'blackhole') client.write(data); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => { if (fault !== 'blackhole') client.destroy(); });
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); if (fault !== 'blackhole') client.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as import('node:net').AddressInfo).port,
    get connections() { return connections; },
    setFault(value: typeof fault) { fault = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
