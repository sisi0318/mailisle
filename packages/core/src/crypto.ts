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
  return timingSafeEqual(await deriveKey(password, salt), Buffer.from(digest, 'hex'));
}

export class Vault {
  constructor(private key: Buffer) {}
  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
  }
  decrypt<T>(encrypted: string): T {
    const [iv, tag, data] = encrypted.split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  }
}
