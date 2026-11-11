import { afterAll, afterEach, expect, it } from 'vitest';
import { oauthStartSchema } from '@mail/shared';
import { accountConfig, database } from '../../../tests/fixtures';
import { Vault } from './crypto';
import { OAuthManager, type AccountConfig } from './oauth';
import { oauthPresets } from './oauth-presets';
import { MailService } from './service';
import { BodyCache } from './cache';

const store = database();
const vault = new Vault(Buffer.alloc(32));
const oauth = new OAuthManager(store, vault);
afterEach(() => { store.sqlite.exec('DELETE FROM settings; DELETE FROM accounts;'); });
afterAll(() => store.close());

it.each([
  ['google', 'preset', true, '127.0.0.1', true], ['google', 'custom', true, '127.0.0.1', true],
  ['microsoft', 'preset', false, '127.0.0.1', false], ['microsoft', 'custom', true, 'localhost', false],
] as const)('resolves the %s %s client matrix', (provider, source, pkce, redirectHost, secret) => {
  const client = oauth.client({ provider, account: accountConfig(), client: source === 'preset' ? { source } : { source, clientId: 'own-id', clientSecret: 'own-secret' } });
  expect(client.pkce).toBe(pkce); expect(client.redirectHost).toBe(redirectHost); expect(!!client.clientSecret).toBe(secret);
});

it('encrypts global clients, retains an unchanged Google secret, and requires a new secret for a changed ID', () => {
  oauth.setClient('google', { clientId: 'own-id', clientSecret: 'private-secret' });
  expect(store.getSetting('oauth-client-google')).not.toContain('private-secret');
  expect(JSON.stringify(oauth.settings())).not.toContain('private-secret');
  oauth.setClient('google', { clientId: 'own-id' });
  expect(oauth.client({ provider: 'google', account: accountConfig(), client: { source: 'global' } }).clientSecret).toBe('private-secret');
  expect(() => oauth.setClient('google', { clientId: 'new-id' })).toThrow('Client secret');
  oauth.setClient('google', null);
  expect(oauth.settings().google.custom).toBeNull();
});

it('keeps own and saved clients usable after removal of the bundled preset or changes to global defaults', () => {
  const preset = oauthPresets.microsoft;
  delete oauthPresets.microsoft;
  try {
    oauth.setClient('microsoft', { clientId: 'own-client' });
    const client = oauth.client({ provider: 'microsoft', account: accountConfig(), client: { source: 'global' } });
    const config: AccountConfig = { ...accountConfig(), oauth: { provider: 'microsoft', client, accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 0 } };
    const id = store.addAccount(config.name, config.email, vault.encrypt(config));
    oauth.setClient('microsoft', { clientId: 'next-client' });
    expect(oauth.client({ provider: 'microsoft', account: accountConfig(), accountId: id, client: { source: 'saved' } }).clientId).toBe('own-client');
    expect(() => oauth.client({ provider: 'microsoft', account: accountConfig(), client: { source: 'preset' } })).toThrow('未配置');
    const service = new MailService(store, vault, new BodyCache('.test-artifacts/oauth-unused'));
    const settings = JSON.stringify(service.accountSettings(id));
    expect(settings).toContain('own-client'); expect(settings).not.toContain('secret'); expect(settings).not.toContain('password');
  } finally { oauthPresets.microsoft = preset; }
});

it('validates OAuth mail endpoints and transport at the HTTP boundary', () => {
  const input = { provider: 'google', client: { source: 'preset' }, account: { ...accountConfig(),
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls', user: 'alice@gmail.com' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls', user: 'alice@gmail.com' } } };
  expect(oauthStartSchema.safeParse(input).success).toBe(true);
  expect(oauthStartSchema.safeParse({ ...input, account: accountConfig() }).success).toBe(false);
  expect(oauthStartSchema.safeParse({ ...input, client: { source: 'custom', clientId: 'id' } }).success).toBe(false);
  expect(oauthStartSchema.safeParse({ ...input, account: { ...input.account, smtp: { ...input.account.smtp, user: 'alice\x01injected' } } }).success).toBe(false);
});
