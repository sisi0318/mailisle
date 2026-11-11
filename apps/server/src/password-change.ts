import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { MailStore } from '@mail/db';
import { deriveKey, hashPassword, Vault } from '@mail/core';
import { validateMasterPassword } from './config';

export async function changeMasterPassword(envFile: string, migrationsDir: string, newPassword: string) {
  validateMasterPassword(newPassword);
  const text = readFileSync(envFile, 'utf8');
  const env = parseEnv(text);
  const dataDir = resolve(dirname(envFile), env.MAIL_DATA_DIR || '.data');
  if (!existsSync(join(dataDir, 'mail.sqlite'))) throw new Error('没有找到已有数据库，请先确认 .env 和数据目录');
  if (/[\r\n]/.test(env.MAIL_MASTER_PASSWORD ?? '')) throw new Error('换密工具要求 .env 中的旧主密码写在单独一行');
  const nextEnv = `${text.replace(/^[ \t]*(?:export\s+)?MAIL_MASTER_PASSWORD\s*=.*(?:\r?\n|$)/gm, '').trimEnd()}\nMAIL_MASTER_PASSWORD=${JSON.stringify(newPassword)}\n`;
  if (parseEnv(nextEnv).MAIL_MASTER_PASSWORD !== newPassword) throw new Error('新密码中的引号或换行无法写入 .env，请换一个密码或使用 --generate');
  const store = new MailStore(join(dataDir, 'mail.sqlite'), migrationsDir);
  const pending = `${envFile}.password-pending-${randomBytes(6).toString('hex')}`;
  try {
    const salt = store.getSetting('vault-salt'); const check = store.getSetting('vault-check');
    if (!salt || !check || !env.MAIL_MASTER_PASSWORD) throw new Error('已有数据库或 .env 缺少主密钥信息');
    const oldVault = new Vault(await deriveKey(env.MAIL_MASTER_PASSWORD, salt));
    try { oldVault.decrypt(check); }
    catch { throw new Error('.env 的旧主密码不能解密此数据库，未修改任何凭据'); }
    const newSalt = randomBytes(32).toString('hex');
    const newVault = new Vault(await deriveKey(newPassword, newSalt));
    const accountValues = store.accounts().map(account => ({ id: account.id, encrypted: newVault.encrypt(oldVault.decrypt(store.account(account.id)!.encryptedConfig)) }));
    const clientValues = ['oauth-client-google', 'oauth-client-microsoft'].flatMap(key => {
      const encrypted = store.getSetting(key);
      return encrypted ? [{ key, encrypted: newVault.encrypt(oldVault.decrypt(encrypted)) }] : [];
    });
    const passwordHash = await hashPassword(newPassword);
    const backupDir = join(dataDir, 'backups', `password-${Date.now()}`);
    mkdirSync(backupDir, { recursive: true });
    await store.sqlite.backup(join(backupDir, 'mail.sqlite'));
    copyFileSync(envFile, join(backupDir, '.env'));
    writeFileSync(pending, nextEnv, { mode: 0o600 });
    store.sqlite.transaction(() => {
      for (const account of accountValues) store.updateAccountCredentials(account.id, account.encrypted);
      for (const client of clientValues) store.setSetting(client.key, client.encrypted);
      store.setSetting('vault-salt', newSalt); store.setSetting('vault-check', newVault.encrypt('mail-v1'));
      store.setSetting('password-hash', passwordHash);
      store.sqlite.exec('DELETE FROM web_sessions');
      // A failed config-file replacement rolls back the credential changes as well.
      renameSync(pending, envFile);
    })();
    return { accounts: accountValues.length, backupDir };
  } finally { store.close(); rmSync(pending, { force: true }); }
}
