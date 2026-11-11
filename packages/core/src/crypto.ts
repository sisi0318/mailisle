import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function deriveKey(password: string, salt: string): Promise<Buffer> {
  return await scrypt(password, salt, 32) as Buffer;
}
export async function hashPassword(password: string) {
  const salt = randomBytes(32).toString('hex');
  return `${salt}:${(await deriveKey(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, digest] = hash.split(':');
  const expected = Buffer.from(digest ?? '', 'hex');
  // timingSafeEqual throws on a length mismatch, so a damaged record is rejected before it gets there.
  if (!salt || expected.length !== 32) return false;
  return timingSafeEqual(await deriveKey(password, salt), expected);
}

export class Vault {
  constructor(private key: Buffer) {}
  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 });
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
  }
  decrypt<T>(encrypted: string): T {
    const parts = encrypted.split('.').map(part => Buffer.from(part, 'base64'));
    const [iv, tag, data] = parts;
    // GCM accepts shortened tags unless told otherwise, which would make a forged record far easier to produce.
    if (parts.length !== 3 || iv.length !== 12 || tag.length !== 16) throw new Error('加密数据格式不正确');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  }
}
