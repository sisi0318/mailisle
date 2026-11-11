import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthProgress, OAuthStart, OAuthStarted } from '@mail/shared';
import { OAuthManager, type AccountConfig, type OAuthClient } from './oauth';

type Session = OAuthProgress & { owner: string; input: OAuthStart; client: OAuthClient; state: string; verifier?: string;
  redirectUri: string; servers: Server[]; timer: ReturnType<typeof setTimeout>; config?: AccountConfig };

export class OAuthFlow {
  private sessions = new Map<string, Session>();
  constructor(private oauth: OAuthManager, private lifetimeMs = 10 * 60_000) {}

  async start(owner: string, input: OAuthStart): Promise<OAuthStarted> {
    // A browser has one active connection dialog; replacing it also releases the old callback port.
    for (const session of this.sessions.values()) if (session.owner === owner) this.remove(session);
    const client = this.oauth.client(input);
    const old = input.accountId ? this.oauth.accountConfig(input.accountId) : undefined;
    input = { ...input, account: { ...input.account, proxy: input.account.proxy === undefined ? old?.proxy : input.account.proxy || undefined } };
    const id = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const verifier = client.pkce ? randomBytes(32).toString('base64url') : undefined;
    const servers: Server[] = [];
    const session: Session = { id, owner, input, client, state, verifier, redirectUri: '', servers,
      status: 'waiting', expiresAt: Date.now() + this.lifetimeMs, timer: setTimeout(() => this.remove(session), this.lifetimeMs) };
    session.timer.unref();
    try {
      const callback = () => createServer((request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        // One request is all this listener ever serves, so the port is released as soon as the answer is sent.
        response.setHeader('Connection', 'close');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        if (request.method !== 'GET' || request.headers.host !== new URL(session.redirectUri).host) {
          response.writeHead(400).end('回调地址不正确'); return;
        }
        void this.receive(session, new URL(request.url ?? '/', session.redirectUri).href).then(() => {
          response.end(session.status === 'ready' ? '授权成功。请返回邮箱应用完成连接，可以关闭此页。' : session.error ?? '授权未完成，请返回邮箱应用。');
        }, () => { response.writeHead(400).end('回调未通过校验，请返回邮箱应用重试。'); });
      });
      const ipv4 = callback(); servers.push(ipv4);
      await listen(ipv4, 0, '127.0.0.1');
      const port = (ipv4.address() as AddressInfo).port;
      session.redirectUri = `http://${client.redirectHost}:${port}/`;
      if (client.redirectHost === 'localhost') {
        // A browser may resolve localhost to either family. A host without IPv6, such as a default Docker network, has no ::1 to listen on.
        const ipv6 = callback();
        try { await listen(ipv6, port, '::1'); servers.push(ipv6); }
        catch (error) { ipv6.close(); if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      this.sessions.set(id, session);
      const url = new URL(this.oauth.endpoints[input.provider].authorize);
      url.search = new URLSearchParams({ client_id: client.clientId, response_type: 'code', redirect_uri: session.redirectUri,
        scope: this.oauth.endpoints[input.provider].scopes.join(' '), state, login_hint: input.account.email,
        ...(input.provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
        ...(verifier ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
      }).toString();
      return { ...this.progress(session), authorizationUrl: url.href, redirectUri: session.redirectUri };
    } catch { this.remove(session); throw new Error('无法启动本机授权回调，请确认本机 IPv4/IPv6 回环可用后重试'); }
  }
  status(id: string, owner: string) { return this.progress(this.session(id, owner)); }
  async paste(id: string, owner: string, url: string) {
    await this.receive(this.session(id, owner), url);
    return this.status(id, owner);
  }
  async finish(id: string, owner: string, save: (config: AccountConfig, accountId?: string) => Promise<string>) {
    const session = this.session(id, owner);
    if (session.status === 'complete') return this.progress(session);
    if (session.status !== 'ready') throw new Error('请先完成邮箱授权');
    session.status = 'saving'; session.error = undefined;
    try {
      session.accountId = await save(session.config!, session.input.accountId);
      session.status = 'complete'; session.config = undefined;
    } catch (error) { session.status = 'ready'; throw error; }
    return this.progress(session);
  }
  cancel(id: string, owner: string) { this.remove(this.session(id, owner)); }
  cancelOwner(owner: string) { for (const session of this.sessions.values()) if (session.owner === owner) this.remove(session); }
  close() { for (const session of this.sessions.values()) this.remove(session); }

  private async receive(session: Session, callback: string) {
    const url = new URL(callback);
    const expected = new URL(session.redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== session.state)
      throw new Error('回调地址或 state 不匹配，请粘贴本次授权的完整回调地址');
    if (session.status !== 'waiting' || session.expiresAt <= Date.now()) throw new Error('本次授权已处理或已过期，请重新发起');
    session.status = 'exchanging';
    try {
      if (url.searchParams.has('error')) throw new Error('邮箱授权未获同意，请重新授权并确认邮件权限');
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1) throw new Error('回调中没有有效授权码，请重新授权');
      const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: session.redirectUri,
        ...(session.verifier ? { code_verifier: session.verifier } : {}) });
      const token = await this.oauth.exchange(session.input.provider, session.client, params, session.input.account.proxy);
      if (!token.refreshToken) throw new Error('服务商没有返回离线访问令牌，请重新授权并同意离线访问');
      session.config = { ...session.input.account, proxy: session.input.account.proxy || undefined,
        oauth: { ...token, refreshToken: token.refreshToken, provider: session.input.provider, client: session.client } };
      session.status = 'ready';
    } catch (error) {
      session.status = 'error'; session.error = error instanceof Error ? error.message : '授权未完成，请重试';
    } finally {
      session.verifier = undefined;
      for (const server of session.servers) server.close();
    }
  }
  private session(id: string, owner: string) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.expiresAt <= Date.now()) throw new Error('授权会话不存在或已过期，请重新发起');
    return session;
  }
  private progress(session: Session): OAuthProgress {
    return { id: session.id, status: session.status, expiresAt: session.expiresAt, error: session.error, accountId: session.accountId };
  }
  private remove(session: Session) {
    clearTimeout(session.timer);
    for (const server of session.servers) { server.close(); server.closeAllConnections(); }
    session.config = undefined;
    this.sessions.delete(session.id);
  }
}

async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, ipv6Only: host === '::1' }, () => { server.removeListener('error', reject); resolve(); });
  });
}
