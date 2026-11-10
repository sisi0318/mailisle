import { resolve } from 'node:path';
import { MailStore } from '../packages/db/src/index';
import type { AccountInput, MailMetadata } from '../packages/shared/src/index';

export const migrations = resolve('packages/db/migrations');
export function database() { return new MailStore(':memory:', migrations); }
export function seedAccount(store: MailStore, email = 'alice@example.com') {
  const accountId = store.addAccount('测试邮箱', email, 'encrypted');
  const folders = store.saveFolders(accountId, [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }, { path: 'Sent', name: 'Sent', role: 'sent' }]);
  for (const folder of folders) store.beginFolder(folder.id, '1');
  return { accountId, inbox: store.folders(accountId).find(f => f.role === 'inbox')!, sent: store.folders(accountId).find(f => f.role === 'sent')! };
}
export function record(uid = 1, changes: Partial<MailMetadata> = {}): MailMetadata {
  return { uid, remoteId: null, providerThreadId: null, messageId: `<${uid}@example.com>`, references: [],
    subject: '电子发票与合同', from: [{ name: '财务部', address: 'billing@example.com' }], to: [{ name: 'Alice', address: 'alice@example.com' }], replyTo: [], date: Date.UTC(2026, 10, uid), flags: [], ...changes };
}
export function accountConfig(): AccountInput {
  return { name: 'Alice', email: 'alice@example.com', sentCopy: 'append',
    imap: { host: '127.0.0.1', port: 3143, security: 'plain', user: 'alice@example.com', password: 'test-password' },
    smtp: { host: '127.0.0.1', port: 3025, security: 'plain', user: 'alice@example.com', password: 'test-password' } };
}
