import { describe, expect, it } from 'vitest';
import { deriveKey, hashPassword, Vault, verifyPassword } from './crypto';
import { accountSchema } from '@mail/shared';
import { accountConfig } from '../../../tests/fixtures';

describe('credentials', () => {
  it('hashes passwords with a fresh salt and checks them', async () => {
    const first = await hashPassword('a long test password');
    expect(await hashPassword('a long test password')).not.toBe(first);
    expect(await verifyPassword('a long test password', first)).toBe(true);
    expect(await verifyPassword('a wrong test password', first)).toBe(false);
  });
  it('encrypts credentials and rejects tampering or a wrong master key', async () => {
    const vault = new Vault(await deriveKey('test-password', 'salt'));
    const encrypted = vault.encrypt(accountConfig());
    expect(encrypted).not.toContain('test-password');
    expect(vault.decrypt(encrypted)).toEqual(accountConfig());
    expect(() => new Vault(Buffer.alloc(32)).decrypt(encrypted)).toThrow();
    const parts = encrypted.split('.');
    const bytes = Buffer.from(parts[2], 'base64'); bytes[0] ^= 1; parts[2] = bytes.toString('base64');
    expect(() => vault.decrypt(parts.join('.'))).toThrow();
  });
  it('validates cleartext and proxy settings at the input boundary', () => {
    expect(accountSchema.safeParse(accountConfig()).success).toBe(true);
    const config = accountConfig(); config.imap.host = 'imap.example.com';
    expect(accountSchema.safeParse(config).success).toBe(false);
    config.imap.security = 'starttls';
    expect(accountSchema.safeParse(config).success).toBe(true);
    expect(accountSchema.safeParse({ ...config, proxy: 'file:///tmp/proxy' }).success).toBe(false);
  });
});
