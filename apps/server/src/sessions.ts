import { createHash, randomBytes } from 'node:crypto';
import type { MailStore } from '@mail/db';

export const SESSION_SECONDS = 7 * 86_400;

export class WebSessions {
  constructor(private store: MailStore) {}
  authenticated(token?: string) {
    return !!token && (this.store.webSession(hash(token))?.expiresAt ?? 0) > Date.now();
  }
  create() {
    const token = randomBytes(32).toString('hex');
    this.store.addWebSession(hash(token), Date.now() + SESSION_SECONDS * 1000);
    return token;
  }
  revoke(token?: string) { if (token) this.store.deleteWebSession(hash(token)); }
}

function hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
