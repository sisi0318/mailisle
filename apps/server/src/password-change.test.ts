import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { MailStore } from '@mail/db';
import { deriveKey, hashPassword, Vault, verifyPassword } from '@mail/core';
import { draftSchema } from '@mail/shared';
import { accountConfig, migrations, record } from '../../../tests/fixtures';
import { changeMasterPassword } from './password-change';

const oldPassword = 'old-master-password'; const newPassword = 'new-master-password-#-safe';
let directory: string; let envFile: string; let filename: string; let accountId: string; let oldVault: Vault;
beforeEach(async () => {
  mkdirSync('.test-artifacts', { recursive: true }); directory = mkdtempSync(resolve('.test-artifacts/password-'));
  envFile = join(directory, '.env'); filename = join(directory, '.data', 'mail.sqlite');
  writeFileSync(envFile, `MAIL_MASTER_PASSWORD=${oldPassword}\nMAIL_PORT=3201\nMAIL_DATA_DIR=.data\n`);
  oldVault = new Vault(await deriveKey(oldPassword, 'old-vault-salt'));
  const store = new MailStore(filename, migrations);
  store.setSetting('vault-salt', 'old-vault-salt'); store.setSetting('vault-check', oldVault.encrypt('mail-v1'));
  store.setSetting('password-hash', await hashPassword(oldPassword));
  store.setSetting('oauth-client-google', oldVault.encrypt({ clientId: 'own-client', clientSecret: 'test-only-secret' }));
  accountId = store.addAccount('Test', accountConfig().email, oldVault.encrypt(accountConfig()));
  store.saveFolders(accountId, [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }]);
  const folder = store.folders(accountId)[0]; store.beginFolder(folder.id, '1'); store.applyBatch(store.folders(accountId)[0], [record()]);
  store.saveDraft(randomUUID(), draftSchema.parse({ accountId, subject: 'keep draft', text: 'keep text' }));
  store.addWebSession('old-session-hash', Date.now() + 10000);
  store.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('rewraps credentials and client secrets, preserves mail and drafts, and invalidates old sessions', async () => {
  const before = new MailStore(filename, migrations); const original = before.sqlite.prepare('SELECT * FROM messages').all(); before.close();
  const result = await changeMasterPassword(envFile, migrations, newPassword);
  expect(result.accounts).toBe(1);
  const env = parseEnv(readFileSync(envFile, 'utf8'));
  expect(env.MAIL_MASTER_PASSWORD).toBe(newPassword); expect(env.MAIL_PORT).toBe('3201');
  const store = new MailStore(filename, migrations);
  try {
    const vault = new Vault(await deriveKey(newPassword, store.getSetting('vault-salt')!));
    expect(vault.decrypt(store.account(accountId)!.encryptedConfig)).toEqual(accountConfig());
    expect(vault.decrypt(store.getSetting('oauth-client-google')!)).toEqual({ clientId: 'own-client', clientSecret: 'test-only-secret' });
    expect(await verifyPassword(newPassword, store.getSetting('password-hash')!)).toBe(true);
    expect(() => oldVault.decrypt(store.account(accountId)!.encryptedConfig)).toThrow();
    expect(store.sqlite.prepare('SELECT * FROM messages').all()).toEqual(original);
    expect(store.drafts()).toHaveLength(1); expect(store.sqlite.prepare('SELECT count(*) n FROM web_sessions').get()).toEqual({ n: 0 });
  } finally { store.close(); }
  const backup = new MailStore(join(result.backupDir, 'mail.sqlite'), migrations);
  try { expect(oldVault.decrypt(backup.account(accountId)!.encryptedConfig)).toEqual(accountConfig()); }
  finally { backup.close(); }
  expect(parseEnv(readFileSync(join(result.backupDir, '.env'), 'utf8')).MAIL_MASTER_PASSWORD).toBe(oldPassword);
});

it('does not alter credentials or the environment when the old key is wrong or the new password is invalid', async () => {
  await expect(changeMasterPassword(envFile, migrations, 'replace-with-a-long-secret')).rejects.toThrow('示例密码');
  writeFileSync(envFile, 'MAIL_MASTER_PASSWORD=wrong-old-password\nMAIL_DATA_DIR=.data\n');
  const text = readFileSync(envFile, 'utf8');
  await expect(changeMasterPassword(envFile, migrations, newPassword)).rejects.toThrow('不能解密');
  expect(readFileSync(envFile, 'utf8')).toBe(text);
  const store = new MailStore(filename, migrations);
  try { expect(oldVault.decrypt(store.account(accountId)!.encryptedConfig)).toEqual(accountConfig()); }
  finally { store.close(); }
});
