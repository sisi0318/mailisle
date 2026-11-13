import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, request, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createServer as createSocketServer, type AddressInfo } from 'node:net';
import type { OAuthProvider } from '@mail/shared';
import { accountConfig, database } from '../../../tests/fixtures';
import { callbackUrl, oauthServer } from '../../../tests/oauth-server';
import { OAuthManager, type AccountConfig } from './oauth';
import { OAuthFlow } from './oauth-flow';
import { Vault } from './crypto';
import { ImapAdapter } from './imap';
import { MailService } from './service';
import { BodyCache } from './cache';
import { oauthMailServer } from '../../../tests/oauth-mail-server';
import { sendSchema } from '@mail/shared';

let store: ReturnType<typeof database>;
let provider: Awaited<ReturnType<typeof oauthServer>>;
let manager: OAuthManager;
let flow: OAuthFlow;
const vault = new Vault(Buffer.alloc(32));
beforeEach(async () => {
  store = database(); provider = await oauthServer(); manager = new OAuthManager(store, vault, provider.endpoints); flow = new OAuthFlow(manager);
});
afterEach(async () => { flow.close(); await provider.close(); store.close(); });

it.each(['google', 'microsoft'] as const)('exchanges a real %s authorization code with PKCE and saves tokens only to encrypted config', async name => {
  const started = await start(name);
  const auth = new URL(started.authorizationUrl);
  expect(auth.searchParams.get('scope')).toBe(provider.endpoints[name].scopes.join(' '));
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  await flow.paste(started.id, 'browser', await callbackUrl(started.authorizationUrl));
  expect(flow.status(started.id, 'browser').status).toBe('ready');
  expect(JSON.stringify(flow.status(started.id, 'browser'))).not.toContain('access-');
  const saved = await flow.finish(started.id, 'browser', async config => store.addAccount(config.name, config.email, vault.encrypt(config)));
  const encrypted = store.account(saved.accountId!)!.encryptedConfig;
  expect(encrypted).not.toContain('refresh-');
  expect(manager.accountConfig(saved.accountId!).oauth?.refreshToken).toBe('refresh-1');
  expect(provider.requests[0].has('client_secret')).toBe(name === 'google');
  expect(provider.requests[0].has('code_verifier')).toBe(true);
});

it('uses no PKCE for the Microsoft preset and receives the actual IPv4 loopback callback', async () => {
  const started = await flow.start('browser', { provider: 'microsoft', client: { source: 'preset' }, account: accountConfig() });
  expect(new URL(started.authorizationUrl).searchParams.has('code_challenge')).toBe(false);
  const result = await fetch(await callbackUrl(started.authorizationUrl));
  expect(await result.text()).toContain('授权成功');
  expect(flow.status(started.id, 'browser').status).toBe('ready');
  expect(provider.requests[0].has('code_verifier')).toBe(false);
  expect(provider.requests[0].has('client_secret')).toBe(false);
});

it('listens on both IPv4 and IPv6 for a custom Microsoft localhost redirect', async () => {
  for (const host of ['127.0.0.1', '::1']) {
    const started = await start('microsoft');
    const callback = new URL(await callbackUrl(started.authorizationUrl));
    const text = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: host, port: callback.port, path: callback.pathname + callback.search, headers: { Host: callback.host } }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body));
      }); req.on('error', reject); req.end();
    });
    expect(text).toContain('授权成功');
  }
});

it('rejects another browser, mismatched callback state/host, duplicate callbacks and expired sessions', async () => {
  const started = await start('google'); const callback = await callbackUrl(started.authorizationUrl);
  expect(() => flow.status(started.id, 'other-browser')).toThrow('不存在');
  await expect(flow.paste(started.id, 'browser', callback.replace('127.0.0.1', 'localhost'))).rejects.toThrow('不匹配');
  const invalid = new URL(callback); invalid.searchParams.set('state', 'wrong');
  await expect(flow.paste(started.id, 'browser', invalid.href)).rejects.toThrow('不匹配');
  expect(provider.requests).toHaveLength(0);
  await flow.paste(started.id, 'browser', callback);
  await expect(flow.paste(started.id, 'browser', callback)).rejects.toThrow('已处理');
  flow.close(); flow = new OAuthFlow(manager, 25);
  const expired = await start('google');
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(() => flow.status(expired.id, 'browser')).toThrow('已过期');
});

it('coalesces concurrent refreshes, persists rotation across restart, and keeps a token when no replacement is returned', async () => {
  const id = await authorize();
  let config = manager.accountConfig(id); config.oauth!.expiresAt = 0; store.updateAccountCredentials(id, vault.encrypt(config));
  expect(await Promise.all([manager.accessToken(config, id), manager.accessToken(config, id)])).toEqual(['access-2', 'access-2']);
  expect(provider.requests).toHaveLength(2);
  manager = new OAuthManager(store, vault, provider.endpoints);
  config = manager.accountConfig(id); expect(config.oauth!.refreshToken).toBe('refresh-2');
  expect(await manager.accessToken(config, id)).toBe('access-2');
  provider.omitRefresh(true); config.oauth!.expiresAt = 0; store.updateAccountCredentials(id, vault.encrypt(config));
  await manager.accessToken(config, id);
  expect(manager.accountConfig(id).oauth!.refreshToken).toBe('refresh-2');
  expect(provider.requests[2].get('refresh_token')).toBe('refresh-2');
});

it('cancels a frozen token request and keeps the next configuration refresh independent', async () => {
  const id = await authorize();
  const config = manager.accountConfig(id); config.oauth!.expiresAt = 0; store.updateAccountCredentials(id, vault.encrypt(config));
  let requests = 0; let oldClosed = false; let nextResponse!: ServerResponse;
  let firstEntered!: () => void; let nextEntered!: () => void;
  const firstReady = new Promise<void>(resolve => { firstEntered = resolve; });
  const nextReady = new Promise<void>(resolve => { nextEntered = resolve; });
  const endpoint = createServer((request, response) => {
    request.resume(); requests++;
    if (requests === 1) { response.once('close', () => { oldClosed = true; }); firstEntered(); }
    else { nextResponse = response; nextEntered(); }
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const token = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/token`;
  manager = new OAuthManager(store, vault, { ...provider.endpoints, google: { ...provider.endpoints.google, token } });
  const old = new AbortController(); const current = new AbortController();
  try {
    const oldRequest = manager.accessToken(config, id, old.signal).catch(error => error);
    await firstReady;
    old.abort(new Error('retired configuration'));
    const fresh = manager.accessToken(config, id, current.signal);
    expect((await oldRequest).message).toBe('retired configuration');
    await nextReady;
    const concurrent = manager.accessToken(config, id, current.signal);
    nextResponse.end(JSON.stringify({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }));
    expect(await Promise.all([fresh, concurrent])).toEqual(['new-access', 'new-access']);
    expect(requests).toBe(2); expect(oldClosed).toBe(true);
    expect(manager.accountConfig(id).oauth?.refreshToken).toBe('new-refresh');
  } finally { old.abort(); current.abort(); endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); }
});

it('closes the actual SMTP socket when verification is cancelled before the greeting', async () => {
  let accepted!: () => void; let disconnected!: () => void;
  const ready = new Promise<void>(resolve => { accepted = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createSocketServer(socket => { socket.on('error', () => {}); socket.on('close', disconnected); accepted(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = accountConfig(); config.smtp.port = (server.address() as AddressInfo).port;
  const controller = new AbortController(); const adapter = new ImapAdapter(config, undefined, undefined, controller.signal);
  try {
    const verifying = adapter.verifySmtp().catch(error => error);
    await ready; controller.abort();
    expect(await verifying).toBeInstanceOf(Error);
    await closed;
    await expect(adapter.connect()).rejects.toThrow('已关闭');
  } finally { await adapter.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('reports revoked consent without leaking server details or overwriting the stored token', async () => {
  const id = await authorize();
  const config = manager.accountConfig(id); config.oauth!.expiresAt = 0; store.updateAccountCredentials(id, vault.encrypt(config));
  const before = store.account(id)!.encryptedConfig;
  provider.setError('invalid_grant');
  await expect(manager.accessToken(config, id)).rejects.toThrow('重新授权');
  expect(store.account(id)!.encryptedConfig).toBe(before);
  const started = await start('google');
  const progress = await flow.paste(started.id, 'browser', await callbackUrl(started.authorizationUrl));
  expect(progress.status).toBe('error'); expect(JSON.stringify(progress)).not.toContain('PRIVATE');
});

it('does not accept incomplete permissions or a missing offline token', async () => {
  for (const missing of ['scope', 'refresh']) {
    provider.setScope(missing === 'scope' ? 'openid' : undefined); provider.omitRefresh(missing === 'refresh');
    const started = await start('google');
    expect((await flow.paste(started.id, 'browser', await callbackUrl(started.authorizationUrl))).status).toBe('error');
    await expect(flow.finish(started.id, 'browser', async () => 'unreachable')).rejects.toThrow('先完成');
    expect(store.accounts()).toHaveLength(0);
  }
});

it('keeps an authorized session ready when mailbox validation fails, allowing a retry without code replay', async () => {
  const started = await start('google'); await flow.paste(started.id, 'browser', await callbackUrl(started.authorizationUrl));
  await expect(flow.finish(started.id, 'browser', async () => { throw new Error('SMTP 未开启'); })).rejects.toThrow('SMTP');
  expect(flow.status(started.id, 'browser').status).toBe('ready');
  await flow.finish(started.id, 'browser', async () => 'saved');
  expect((await flow.finish(started.id, 'browser', async () => 'must-not-save-twice')).accountId).toBe('saved');
  expect(provider.requests).toHaveLength(1);
});

it('uses fresh XOAUTH2 on IMAP reconnect, IDLE and SMTP, without replaying a rejected send', async () => {
  const mail = await oauthMailServer();
  const id = await authorize();
  const config = manager.accountConfig(id);
  config.imap.port = mail.imapPort; config.smtp.port = mail.smtpPort; config.sentCopy = 'server'; config.oauth!.expiresAt = 0;
  store.updateAccountCredentials(id, vault.encrypt(config));
  let adapter = new ImapAdapter(config, undefined, () => manager.accessToken(config, id));
  let stopWatch: (() => void) | undefined;
  try {
    await adapter.connect(); await adapter.verifySmtp();
    stopWatch = await adapter.watchInbox(() => {}, () => {});
    await adapter.close();
    adapter = new ImapAdapter(config, undefined, () => manager.accessToken(config, id));
    await adapter.connect();
    const send = sendSchema.parse({ accountId: id, to: ['local-test@example.com'], subject: 'OAuth fixture', text: 'Only sent to the local fixture.' });
    await adapter.send(send);
    expect(mail.messages).toHaveLength(1);
    expect(mail.logins.map(login => login.protocol)).toEqual(['imap', 'smtp', 'imap', 'imap', 'smtp']);
    expect(mail.logins.every(login => login.token === 'access-2' && login.user === config.email)).toBe(true);
    expect(provider.requests).toHaveLength(2);
    mail.rejectAuthentication(true);
    await expect(adapter.send(send)).rejects.toThrow('OAuth 发信');
    expect(mail.messages).toHaveLength(1);
  } finally { stopWatch?.(); await adapter.close(); await mail.close(); }
});

it('validates and adopts OAuth accounts through MailService and keeps folder identity on reauthorization', async () => {
  const mail = await oauthMailServer();
  const service = new MailService(store, vault, new BodyCache('.test-artifacts/oauth-service-unused'), undefined, undefined, manager);
  const config: AccountConfig = { ...accountConfig(), imap: { ...accountConfig().imap, port: mail.imapPort }, smtp: { ...accountConfig().smtp, port: mail.smtpPort } };
  const session = await flow.start('browser', { provider: 'google', account: config, client: { source: 'preset' } });
  await flow.paste(session.id, 'browser', await callbackUrl(session.authorizationUrl));
  try {
    const saved = await flow.finish(session.id, 'browser', (input, id) => service.saveOAuthAccount(input, id));
    const id = saved.accountId!; await service.sync(id);
    const foldersBefore = store.folders(id).map(folder => folder.id);
    const next = await flow.start('browser', { provider: 'google', account: config, accountId: id, client: { source: 'saved' } });
    await flow.paste(next.id, 'browser', await callbackUrl(next.authorizationUrl));
    await flow.finish(next.id, 'browser', (input, target) => service.saveOAuthAccount(input, target));
    await service.sync(id);
    expect(store.folders(id).map(folder => folder.id)).toEqual(foldersBefore);
    expect(manager.accountConfig(id).oauth!.accessToken).toBe('access-2');
    expect(JSON.stringify(service.accountSettings(id))).not.toContain('access-');
    expect(mail.logins.filter(login => login.token === 'access-2').length).toBeGreaterThanOrEqual(2);
  } finally { await service.stop(); await mail.close(); }
});

it.each(['custom', 'global'] as const)('routes token exchange and refresh through the %s HTTP proxy, including proxy authentication', async mode => {
  const received: { url: string; authorization?: string }[] = [];
  const proxy = createServer((incoming, outgoing) => {
    received.push({ url: incoming.url!, authorization: incoming.headers['proxy-authorization'] });
    const forwarded = request(incoming.url!, { method: incoming.method, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, response => {
      outgoing.writeHead(response.statusCode!); response.pipe(outgoing);
    }); forwarded.on('error', () => outgoing.writeHead(502).end()); incoming.pipe(forwarded);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const proxyUrl = `http://proxy-user:proxy-pass@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  if (mode === 'global') manager.proxies.save(proxyUrl);
  const config = { ...accountConfig(), proxyMode: mode, proxy: mode === 'custom' ? proxyUrl : undefined };
  try {
    const session = await flow.start('browser', { provider: 'google', account: config, client: { source: 'preset' } });
    await flow.paste(session.id, 'browser', await callbackUrl(session.authorizationUrl));
    const saved = await flow.finish(session.id, 'browser', async input => store.addAccount(input.name, input.email, vault.encrypt(input)));
    const stored = manager.accountConfig(saved.accountId!); stored.oauth!.expiresAt = 0;
    store.updateAccountCredentials(saved.accountId!, vault.encrypt(stored));
    await manager.accessToken(stored, saved.accountId!);
    expect(received).toHaveLength(2);
    expect(received.every(item => item.url === provider.endpoints.google.token && item.authorization === `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`)).toBe(true);
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

function start(name: OAuthProvider) {
  return flow.start('browser', { provider: name, client: { source: 'custom', clientId: 'own-client', clientSecret: name === 'google' ? 'own-secret' : undefined }, account: accountConfig() });
}
async function authorize() {
  const started = await start('google'); await flow.paste(started.id, 'browser', await callbackUrl(started.authorizationUrl));
  const result = await flow.finish(started.id, 'browser', async (config: AccountConfig) => store.addAccount(config.name, config.email, vault.encrypt(config)));
  return result.accountId!;
}
