import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import PostalMime from 'postal-mime';
import { accountUpdateSchema, draftSchema, listSchema, sendSchema } from '@mail/shared';
import { accountConfig, database } from '../../../tests/fixtures';
import { BodyCache } from './cache';
import { MailService } from './service';
import { UploadStore } from './uploads';
import { Vault } from './crypto';

let directory: string;
let store: ReturnType<typeof database>;
let service: MailService;
let direct: ImapFlow;
let accountId: string;
const unique = `draft-${randomUUID()}`;
const config = accountConfig();

beforeAll(async () => {
  await mkdir('.test-artifacts', { recursive: true }); directory = await mkdtemp(resolve('.test-artifacts/draft-protocol-'));
  store = database(); service = new MailService(store, new Vault(Buffer.alloc(32)), new BodyCache(resolve(directory, 'bodies')), undefined, new UploadStore(store, resolve(directory, 'uploads')));
  direct = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, doSTARTTLS: false, auth: { user: config.imap.user, pass: config.imap.password }, logger: false });
  direct.on('error', () => {}); await direct.connect();
  if (!(await direct.list()).some(folder => folder.path === 'Sent')) await direct.mailboxCreate('Sent');
  accountId = await service.addAccount(config); await service.sync(accountId);
});
afterAll(async () => { direct?.close(); await service?.stop(); store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('sends a saved draft with exact attachment bytes and one Sent copy, then removes the local draft', async () => {
  const bytes = Buffer.from([0, 255, 1, 2, 3, 4]);
  const file = await service.uploads!.save('资料.bin', 'application/octet-stream', bytes);
  const draft = await service.saveDraft(undefined, draftSchema.parse({ accountId, to: 'bob@example.com', bcc: 'alice@example.com', subject: `${unique} attachment`, text: '见附件', attachmentIds: [file.id] }));
  const result = await service.send(sendSchema.parse({ ...draft, to: ['bob@example.com'], cc: [], bcc: ['alice@example.com'], draftId: draft.id }));
  expect(result.warning).toBeUndefined(); await service.sync(accountId);
  expect(store.draft(draft.id)).toBeUndefined(); expect(store.upload(file.id)).toBeUndefined();
  const sent = store.folders(accountId).find(folder => folder.role === 'sent')!;
  expect(store.list(listSchema.parse({ folderId: sent.id, q: `${unique} attachment` })).total).toBe(1);
  const bob = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, doSTARTTLS: false, auth: { user: 'bob@example.com', pass: 'test-password' }, logger: false });
  bob.on('error', () => {});
  try {
    await bob.connect(); await bob.mailboxOpen('INBOX');
    const uids = await bob.search({ header: { subject: `${unique} attachment` } }, { uid: true });
    expect(uids && uids.length).toBe(1);
    if (!uids) throw new Error('Missing received message');
    const received = await bob.fetchOne(uids[0], { source: true }, { uid: true });
    if (!received || !received.source) throw new Error('Missing MIME source');
    const parsed = await PostalMime.parse(received.source);
    expect(parsed.bcc).toBeUndefined(); expect(parsed.attachments[0].filename).toBe('资料.bin');
    expect(Buffer.from(parsed.attachments[0].content as Uint8Array)).toEqual(bytes);
  } finally { bob.close(); }
});

it('prepares reply-all with Cc and forwarding with original attachments', async () => {
  const source = await new MailComposer({ from: 'Sender <sender@example.com>', replyTo: 'response@example.com', to: config.email, cc: ['bob@example.com', config.email],
    subject: `${unique} original`, text: '原始正文 <script>不会执行</script>', attachments: [
      { filename: '合同.txt', content: '附件正文', contentType: 'text/plain' },
      { filename: 'logo.png', content: Buffer.from('iVBORw0KGgo=', 'base64'), contentType: 'image/png', cid: 'logo' },
    ] }).compile().build();
  await direct.append('INBOX', source); await service.sync(accountId);
  const message = store.list(listSchema.parse({ q: `${unique} original` })).messages[0];
  const reply = await service.compose(message.id, 'reply-all', true);
  expect(reply.to).toBe('response@example.com'); expect(reply.cc).toBe('bob@example.com');
  expect(reply.html).toContain('&lt;script&gt;'); expect(reply.html).not.toContain('<script>');
  const forward = await service.compose(message.id, 'forward', true);
  expect(forward.to).toBe(''); expect(forward.attachments.map(file => file.filename)).toEqual(['合同.txt', 'logo.png']);
  const textOnly = await service.compose(message.id, 'forward', false);
  expect(textOnly.attachmentIds).toEqual([]);
});

it('updates account settings without reimporting existing message IDs', async () => {
  const before = store.list(listSchema.parse({ q: unique, view: 'all' })).messages.map(message => message.id).sort();
  await service.updateAccount(accountId, accountUpdateSchema.parse({ ...service.accountSettings(accountId), name: 'Updated Alice' }));
  await service.sync(accountId);
  expect(store.account(accountId)?.error).toBeNull(); expect(store.account(accountId)?.name).toBe('Updated Alice');
  expect(store.list(listSchema.parse({ q: unique, view: 'all' })).messages.map(message => message.id).sort()).toEqual(before);
});
