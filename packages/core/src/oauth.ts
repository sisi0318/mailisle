import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { z } from 'zod';
import type { MailStore } from '@mail/db';
import type { AccountInput, OAuthClientInfo, OAuthClientInput, OAuthClientSettings, OAuthProvider, OAuthStart } from '@mail/shared';
import type { Vault } from './crypto';
import { oauthPresets } from './oauth-presets';
import { ProxySettings } from './proxy';

export const oauthProviders = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scopes: ['https://mail.google.com/'] },
  microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'offline_access'] },
};
export type OAuthEndpoints = typeof oauthProviders;
export type OAuthClient = OAuthClientInput & { source: OAuthClientInfo['source']; pkce: boolean; redirectHost: '127.0.0.1' | 'localhost' };
export type OAuthCredentials = { provider: OAuthProvider; client: OAuthClient; accessToken: string; refreshToken: string; expiresAt: number };
export type AccountConfig = Omit<AccountInput, 'imap' | 'smtp'> & {
  imap: Omit<AccountInput['imap'], 'password'> & { password?: string };
  smtp: Omit<AccountInput['smtp'], 'password'> & { password?: string };
  oauth?: OAuthCredentials;
};
const tokenSchema = z.object({ access_token: z.string().min(1).regex(/^[^\x00-\x20\x7f]+$/), token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().positive().finite(), refresh_token: z.string().min(1).optional(), scope: z.string().optional() });

export class OAuthManager {
  private refreshing = new Map<string, Promise<string>>();
  readonly proxies: ProxySettings;
  constructor(private store: MailStore, private vault: Vault, readonly endpoints: OAuthEndpoints = oauthProviders) {
    this.proxies = new ProxySettings(store, vault);
  }

  settings(): OAuthClientSettings {
    return Object.fromEntries((['google', 'microsoft'] as const).map(provider => {
      const custom = this.customClient(provider);
      return [provider, { presetAvailable: !!oauthPresets[provider], custom: custom ? { clientId: custom.clientId, hasSecret: !!custom.clientSecret } : null }];
    })) as OAuthClientSettings;
  }
  setClient(provider: OAuthProvider, input: OAuthClientInput | null) {
    if (input && provider === 'microsoft') input = { clientId: input.clientId };
    if (input && provider === 'google' && !input.clientSecret) {
      const old = this.customClient(provider);
      if (!old || old.clientId !== input.clientId || !old.clientSecret) throw new Error('Google 桌面客户端需要 Client secret');
      input = { ...input, clientSecret: old.clientSecret };
    }
    this.store.setSetting(`oauth-client-${provider}`, this.vault.encrypt(input));
  }
  client(input: OAuthStart): OAuthClient {
    const { provider, client } = input;
    if (client.source === 'saved') {
      const saved = input.accountId && this.accountConfig(input.accountId).oauth;
      if (!saved || saved.provider !== provider) throw new Error('此邮箱没有可复用的 OAuth 客户端，请重新选择');
      return saved.client;
    }
    const credentials = client.source === 'preset' ? oauthPresets[provider] : client.source === 'global' ? this.customClient(provider) : client;
    if (!credentials) throw new Error('所选 OAuth 客户端未配置，请打开设置');
    return { ...credentials, clientSecret: provider === 'google' ? credentials.clientSecret : undefined, source: client.source, pkce: provider === 'google' || client.source !== 'preset',
      redirectHost: provider === 'microsoft' && client.source !== 'preset' ? 'localhost' : '127.0.0.1' };
  }
  accountConfig(id: string) {
    const account = this.store.account(id);
    if (!account) throw new Error('邮箱不存在');
    return this.vault.decrypt<AccountConfig>(account.encryptedConfig);
  }
  accessToken(config: AccountConfig, accountId?: string): Promise<string> {
    const proxy = this.proxies.resolve(config);
    if (!accountId) return this.refresh({ ...config, proxy });
    const pending = this.refreshing.get(accountId);
    if (pending) return pending;
    const work = this.refresh({ ...this.accountConfig(accountId), proxy }, accountId).finally(() => this.refreshing.delete(accountId));
    this.refreshing.set(accountId, work);
    return work;
  }
  async exchange(provider: OAuthProvider, client: OAuthClient, params: URLSearchParams, proxy?: string) {
    params.set('client_id', client.clientId);
    if (provider === 'microsoft') params.set('scope', this.endpoints[provider].scopes.join(' '));
    if (client.clientSecret) params.set('client_secret', client.clientSecret);
    const response = await tokenRequest(this.endpoints[provider].token, params, proxy);
    if (response.error) throw new Error(response.error === 'invalid_grant' ? '邮箱授权已过期或被撤销，请到邮箱设置重新授权'
      : response.error === 'invalid_client' || response.error === 'unauthorized_client' ? 'OAuth 客户端被拒绝，请检查客户端设置或换用自己的客户端'
      : '邮件服务商拒绝了授权请求，请重新授权并确认邮件权限');
    const parsed = tokenSchema.safeParse(response);
    if (!parsed.success) throw new Error('邮件服务商返回的令牌不完整，请重新授权');
    const token = parsed.data;
    if (token.scope) {
      const granted = new Set(token.scope.split(/\s+/));
      const required = this.endpoints[provider].scopes.filter(scope => scope !== 'offline_access');
      if (required.some(scope => !granted.has(scope))) throw new Error('未授予完整的收发信权限，请重新授权并勾选邮件访问权限');
    }
    return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 };
  }
  private customClient(provider: OAuthProvider) {
    const encrypted = this.store.getSetting(`oauth-client-${provider}`);
    return encrypted ? this.vault.decrypt<OAuthClientInput | null>(encrypted) : null;
  }
  private async refresh(config: AccountConfig, accountId?: string) {
    const oauth = config.oauth;
    if (!oauth) throw new Error('此邮箱未使用 OAuth，请重新连接');
    if (oauth.expiresAt > Date.now() + 60_000) return oauth.accessToken;
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken });
    const token = await this.exchange(oauth.provider, oauth.client, params, config.proxy);
    Object.assign(oauth, token, { refreshToken: token.refreshToken ?? oauth.refreshToken });
    if (accountId) {
      const current = this.accountConfig(accountId);
      // Keep edits to server settings; refresh only replaces the credentials it started with.
      if (current.oauth?.refreshToken === params.get('refresh_token')) {
        current.oauth = oauth;
        this.store.updateAccountCredentials(accountId, this.vault.encrypt(current));
      }
    }
    return oauth.accessToken;
  }
}

async function tokenRequest(endpoint: string, params: URLSearchParams, proxy?: string): Promise<Record<string, unknown>> {
  const agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const request = (endpoint.startsWith('https:') ? httpsRequest : httpRequest)(endpoint, {
        method: 'POST', agent, signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) response.destroy(new Error('OAuth 响应过大'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
            if (response.statusCode !== 200 && !('error' in body)) throw new Error();
            resolve(body as Record<string, unknown>);
          } catch { reject(new Error('邮件服务商的授权响应无法读取，请稍后重试')); }
        });
      });
      request.on('error', () => reject(new Error('无法连接授权服务器，请检查账号代理和网络后重试')));
      request.end(params.toString());
    });
  } finally { agent?.destroy(); }
}
