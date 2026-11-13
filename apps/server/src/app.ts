import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { accountSchema, accountUpdateSchema, composeSchema, discoverySchema, draftSchema, flagsSchema, listSchema, loginSchema, MAX_ATTACHMENT_BYTES, moveSchema, RAW_PREVIEW_BYTES, sendSchema, type RawMessage, type SyncEvent } from '@mail/shared';
import { discoverAccount, errorStatus, publicError, UserError, verifyPassword, type MailService } from '@mail/core';
import { accountOrderSchema, createFolderSchema, globalProxySchema, updateSettingsSchema, oauthStartSchema, oauthProviderSchema, oauthClientUpdateSchema, oauthCallbackSchema } from '@mail/shared';
import { createAccessPolicy } from './access';
import { SESSION_SECONDS, WebSessions } from './sessions';
import { clientKey, LoginLimiter } from './login-limit';
import { UpdateChecker, UpdateManager } from './updates';

const PUBLIC_PATHS = ['/api/session', '/api/login'];

type Options = { service: MailService; passwordHash: string; port: number; webRoot?: string; docsRoot?: string; dev?: boolean; publicUrl?: string; https?: boolean; updates?: UpdateChecker; updateManager?: UpdateManager };

export function createApp({ service, passwordHash, port, webRoot, docsRoot = resolve('docs'), dev = false, publicUrl, https = false,
  updates = new UpdateChecker(undefined, undefined, () => service.oauth.proxies.globalUrl()),
  updateManager = new UpdateManager(service.store, updates, () => service.events.emit('update', { type: 'settings' } satisfies SyncEvent)) }: Options) {
  const app = new Hono<{ Variables: { secureCookie: boolean } }>();
  const sessions = new WebSessions(service.store);
  const sessionEvents = new EventEmitter();
  const access = createAccessPolicy({ port, publicUrl, https, dev });
  const logins = new LoginLimiter();
  const authenticated = (token: string | undefined) => sessions.authenticated(token);

  app.use('*', async (c, next) => {
    const expectedOrigin = access.originForHost(c.req.header('host') ?? new URL(c.req.url).host);
    if (!expectedOrigin) return c.json({ error: '不允许的 Host；使用域名访问时请设置 MAIL_PUBLIC_URL' }, 403);
    const origin = c.req.header('origin');
    if (origin && !access.acceptsOrigin(expectedOrigin, origin)) return c.json({ error: '不允许的请求来源' }, 403);
    // Another port or a sibling subdomain is the same site to the browser and would carry the session cookie.
    if (c.req.path.startsWith('/api/') && ['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '')) return c.json({ error: '不允许跨站请求' }, 403);
    if (!['GET', 'HEAD'].includes(c.req.method) && !origin) return c.json({ error: '请求缺少 Origin' }, 403);
    c.set('secureCookie', expectedOrigin.startsWith('https:'));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    // The reader frame is built from a string and inherits this policy, so images from the web have to be
    // allowed here for "show images" to work at all. The frame's own policy keeps them out until that is asked for.
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    await next();
  });
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (PUBLIC_PATHS.includes(c.req.path)) return next();
    if (!authenticated(getCookie(c, 'mail_session'))) return c.json({ error: '请先登录' }, 401);
    await next();
  });
  // The limit buffers a chunked body before it can measure it, so it runs after the login check and
  // leaves only a few kilobytes for anyone who has not logged in.
  const tooLarge = (c: Context) => c.json({ error: '请求内容过大' }, 413);
  const publicBody = bodyLimit({ maxSize: 16 * 1024, onError: tooLarge });
  const privateBody = bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024, onError: tooLarge });
  app.use('/api/*', (c, next) => (PUBLIC_PATHS.includes(c.req.path) ? publicBody : privateBody)(c, next));
  app.get('/api/session', c => c.json({ authenticated: authenticated(getCookie(c, 'mail_session')) }));
  app.post('/api/login', async c => {
    // Counted before the body is read, so malformed requests use up attempts as well.
    const client = remoteClient(c);
    if (!logins.allow(client)) return c.json({ error: '登录尝试过于频繁，请一分钟后重试' }, 429);
    const parsed = loginSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
    if (!await verifyPassword(parsed.data.password, passwordHash)) return c.json({ error: '密码不正确' }, 401);
    logins.reset(client);
    const token = sessions.create();
    setCookie(c, 'mail_session', token, { httpOnly: true, sameSite: 'Strict', secure: c.get('secureCookie'), path: '/', maxAge: SESSION_SECONDS });
    return c.json({ authenticated: true });
  });
  app.post('/api/logout', c => {
    const token = getCookie(c, 'mail_session');
    service.oauthFlow.cancelOwner(token ?? '');
    sessions.revoke(token);
    sessionEvents.emit('logout', token);
    deleteCookie(c, 'mail_session', { path: '/', secure: c.get('secureCookie'), httpOnly: true, sameSite: 'Strict' });
    return c.json({ ok: true });
  });
  app.get('/api/accounts', c => c.json(service.store.accounts()));
  app.get('/api/version', c => c.json(updates.current));
  app.post('/api/updates/check', async c => c.json(await updateManager.check()));
  app.get('/api/updates/status', c => c.json(updateManager.state()));
  app.post('/api/updates/open', async c => c.json(await updateManager.automatic('open')));
  app.get('/api/settings/updates', c => c.json(updateManager.settings()));
  app.put('/api/settings/updates', async c => {
    const parsed = updateSettingsSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '更新设置不正确' }, 400);
    return c.json(updateManager.save(parsed.data));
  });
  app.get('/api/settings/proxy', c => c.json(service.oauth.proxies.settings()));
  app.put('/api/settings/proxy', async c => {
    const parsed = globalProxySchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '请填写有效的 HTTP 或 SOCKS5 代理地址' }, 400);
    return c.json(await service.setGlobalProxy(parsed.data.proxy));
  });
  app.put('/api/accounts/order', async c => {
    const parsed = accountOrderSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '邮箱顺序不正确，请刷新后重试' }, 400);
    service.reorderAccounts(parsed.data.accountIds);
    return c.json(service.store.accounts());
  });
  app.get('/api/oauth/clients', c => c.json(service.oauth.settings()));
  app.put('/api/oauth/clients/:provider', async c => {
    const provider = oauthProviderSchema.safeParse(c.req.param('provider'));
    const input = oauthClientUpdateSchema.safeParse(await readJson(c));
    if (!provider.success || !input.success) return c.json({ error: 'OAuth 客户端设置不正确' }, 400);
    service.oauth.setClient(provider.data, input.data);
    service.events.emit('update', { type: 'settings' } satisfies SyncEvent);
    return c.json(service.oauth.settings());
  });
  app.get('/api/oauth/docs/:provider', async c => {
    const provider = oauthProviderSchema.safeParse(c.req.param('provider'));
    if (!provider.success) return c.notFound();
    return c.text(await readFile(join(docsRoot, `oauth-${provider.data}.md`), 'utf8'));
  });
  app.post('/api/oauth/start', async c => {
    const parsed = oauthStartSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json(await service.oauthFlow.start(getCookie(c, 'mail_session')!, parsed.data), 201);
  });
  app.get('/api/oauth/sessions/:id', c => c.json(service.oauthFlow.status(c.req.param('id'), getCookie(c, 'mail_session')!)));
  app.post('/api/oauth/sessions/:id/callback', async c => {
    const parsed = oauthCallbackSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '请粘贴完整回调网址' }, 400);
    return c.json(await service.oauthFlow.paste(c.req.param('id'), getCookie(c, 'mail_session')!, parsed.data.url));
  });
  app.post('/api/oauth/sessions/:id/complete', async c => c.json(await service.oauthFlow.finish(c.req.param('id'), getCookie(c, 'mail_session')!,
    (config, id) => service.saveOAuthAccount(config, id))));
  app.delete('/api/oauth/sessions/:id', c => {
    service.oauthFlow.cancel(c.req.param('id'), getCookie(c, 'mail_session')!);
    return c.json({ ok: true });
  });
  app.get('/api/accounts/:id', c => {
    if (!service.store.account(c.req.param('id'))) return c.json({ error: '邮箱不存在' }, 404);
    return c.json(service.accountSettings(c.req.param('id')));
  });
  app.put('/api/accounts/:id', async c => {
    await service.updateAccount(c.req.param('id'), await readAccountUpdate(c, service));
    return c.json({ ok: true });
  });
  app.post('/api/accounts/:id/verify', async c => c.json(await service.verifyAccountSettings(c.req.param('id'), await readAccountUpdate(c, service), c.req.raw.signal)));
  app.post('/api/autoconfig', async c => {
    const parsed = discoverySchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '请输入有效邮箱地址' }, 400);
    return c.json({ config: await discoverAccount(parsed.data.email) });
  });
  app.get('/api/counts', c => c.json(service.store.unreadCounts()));
  app.post('/api/uploads', async c => {
    if (!c.req.header('content-type')?.startsWith('multipart/form-data')) return c.json({ error: '请使用附件上传表单' }, 415);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: '请选择一个附件' }, 400);
    if (!service.uploads) return c.json({ error: '附件存储未配置' }, 503);
    if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: '附件不能超过 20 MiB' }, 413);
    return c.json(await service.uploads.save(file.name, file.type, Buffer.from(await file.arrayBuffer())), 201);
  });
  app.delete('/api/uploads/:id', async c => {
    await service.uploads?.removeUnused([c.req.param('id')]);
    return c.json({ ok: true });
  });
  app.get('/api/uploads/:id', async c => {
    if (!service.store.upload(c.req.param('id'))) return c.json({ error: '附件不存在' }, 404);
    if (!service.uploads) return c.json({ error: '附件存储未配置' }, 503);
    const [file] = await service.uploads.attachments([c.req.param('id')]);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`);
    return c.body(view(file.content));
  });
  app.get('/api/drafts', c => c.json(service.store.drafts(c.req.query('accountId'))));
  app.get('/api/drafts/:id', c => {
    if (!service.store.draft(c.req.param('id'))) return c.json({ error: '草稿不存在' }, 404);
    return c.json(service.getDraft(c.req.param('id')));
  });
  app.post('/api/drafts', async c => {
    const parsed = draftSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '草稿内容不正确，请检查长度和附件' }, 400);
    return c.json(await service.saveDraft(undefined, parsed.data), 201);
  });
  app.put('/api/drafts/:id', async c => {
    if (!service.store.draft(c.req.param('id'))) return c.json({ error: '草稿不存在' }, 404);
    const parsed = draftSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '草稿内容不正确，请检查长度和附件' }, 400);
    return c.json(await service.saveDraft(c.req.param('id'), parsed.data));
  });
  app.delete('/api/drafts/:id', async c => {
    if (!service.store.draft(c.req.param('id'))) return c.json({ error: '草稿不存在' }, 404);
    await service.deleteDraft(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/accounts', async c => {
    const parsed = accountSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }, 400);
    return c.json({ id: await service.addAccount(parsed.data) }, 201);
  });
  app.delete('/api/accounts/:id', async c => {
    if (!service.store.account(c.req.param('id'))) return c.json({ error: '账号不存在' }, 404);
    await service.deleteAccount(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/accounts/:id/sync', c => {
    if (!service.store.account(c.req.param('id'))) return c.json({ error: '账号不存在' }, 404);
    void service.sync(c.req.param('id'));
    return c.json({ ok: true }, 202);
  });
  app.post('/api/accounts/:id/read-all', async c => {
    await service.markAllRead(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/folders/:id/read-all', async c => {
    const folder = service.store.folder(c.req.param('id'));
    if (!folder) return c.json({ error: '文件夹不存在' }, 404);
    await service.markAllRead(folder.accountId, folder.id);
    return c.json({ ok: true });
  });
  app.post('/api/accounts/:id/folders', async c => {
    const parsed = createFolderSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '请输入有效的文件夹名称' }, 400);
    const folder = await service.createFolder(c.req.param('id'), parsed.data.name, parsed.data.parentId);
    return c.json({ folder }, 201);
  });
  app.get('/api/folders', c => c.json(service.store.folders()));
  app.delete('/api/folders/:id', async c => {
    await service.deleteFolder(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/messages', c => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: '查询条件不正确' }, 400);
    return c.json(service.store.list(parsed.data));
  });
  app.use('/api/messages/:id/*', async (c, next) => {
    if (!service.store.message(c.req.param('id')!)) return c.json({ error: '邮件不存在' }, 404);
    await next();
  });
  app.get('/api/messages/:id/body', async c => c.json(await service.body(c.req.param('id'))));
  app.get('/api/messages/:id/raw', async c => {
    const id = c.req.param('id');
    const source = await service.raw(id);
    if (c.req.query('download') === '1') {
      const subject = service.store.message(id)?.subject ?? '';
      const baseName = (subject || 'message').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'message';
      const filename = `${baseName}.eml`;
      c.header('Content-Disposition', `attachment; filename="message.eml"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`);
      c.header('Content-Type', 'message/rfc822');
      return c.body(view(source));
    }
    const truncated = source.byteLength > RAW_PREVIEW_BYTES;
    const slice = truncated ? source.subarray(0, RAW_PREVIEW_BYTES) : source;
    const content = new TextDecoder('utf-8').decode(slice, { stream: truncated });
    const payload: RawMessage = { content, size: source.byteLength, truncated };
    return c.json(payload);
  });
  app.get('/api/messages/:id/thread', c => c.json(service.store.thread(service.store.message(c.req.param('id'))!.threadId)));
  app.post('/api/messages/:id/draft', async c => {
    const parsed = composeSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '写信操作不正确' }, 400);
    return c.json(await service.compose(c.req.param('id'), parsed.data.mode, parsed.data.includeAttachments, parsed.data.timeZone), 201);
  });
  app.patch('/api/messages/:id/flags', async c => {
    const parsed = flagsSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '标记参数不正确' }, 400);
    await service.flags(c.req.param('id'), parsed.data);
    return c.json({ ok: true });
  });
  app.post('/api/messages/:id/move', async c => {
    const parsed = moveSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: '文件夹参数不正确' }, 400);
    await service.move(c.req.param('id'), parsed.data.folderId);
    return c.json({ ok: true });
  });
  app.get('/api/messages/:id/attachments/:attachmentId', async c => {
    const attachment = await service.attachment(c.req.param('id'), c.req.param('attachmentId'));
    c.header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/'/g, '%27')}`);
    c.header('Content-Type', 'application/octet-stream');
    return c.body(view(attachment.content));
  });
  app.post('/api/send', async c => {
    const parsed = sendSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }, 400);
    return c.json(await service.send(parsed.data));
  });
  app.get('/api/events', c => streamSSE(c, async stream => {
    const token = getCookie(c, 'mail_session');
    await stream.writeSSE({ event: 'ready', data: '{}' });
    await new Promise<void>(resolve => {
      const send = (event: SyncEvent) => {
        if (!authenticated(token)) { cleanup(); return; }
        void stream.writeSSE({ event: 'update', data: JSON.stringify(event) }).catch(cleanup);
      };
      const logout = (revoked: string) => { if (revoked === token) cleanup(); };
      const heartbeat = setInterval(() => {
        if (!authenticated(token)) { cleanup(); return; }
        void stream.writeSSE({ event: 'ping', data: '{}' }).catch(cleanup);
      }, 15_000);
      function cleanup() { clearInterval(heartbeat); service.events.off('update', send); sessionEvents.off('logout', logout); resolve(); }
      service.events.on('update', send);
      sessionEvents.on('logout', logout);
      stream.onAbort(cleanup);
    });
  }));
  app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
  if (webRoot) {
    app.use('*', serveStatic({ root: webRoot }));
    app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  }
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const status = errorStatus(error);
    if (status >= 500) console.error(`[api] ${c.req.method} ${c.req.path} ${status}`, describe(error));
    return c.json({ error: publicError(error) }, status);
  });
  return app;
}

async function readAccountUpdate(c: Context, service: MailService) {
  const id = c.req.param('id')!;
  if (!service.store.account(id)) throw new UserError('邮箱不存在', 404);
  const parsed = accountUpdateSchema.safeParse(await readJson(c));
  if (!parsed.success) throw new UserError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'), 400);
  const oauth = service.accountSettings(id).oauth;
  if (oauth) {
    const oauthInput = oauthStartSchema.safeParse({ accountId: id, account: parsed.data, provider: oauth.provider, client: { source: 'saved' } });
    if (!oauthInput.success) throw new UserError(oauthInput.error.issues[0].message, 400);
  }
  return parsed.data;
}

/** A SyntaxError from anywhere else is a fault in the server, not in the request. */
async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); }
  catch { throw new UserError('请求不是有效的 JSON'); }
}

/** The same bytes without copying them; an attachment can be tens of megabytes. */
function view(content: Buffer) {
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength) as Uint8Array<ArrayBuffer>;
}

function remoteClient(c: Context) {
  let peer: string | undefined;
  try { peer = getConnInfo(c).remote.address; } catch { /* Requests made in tests have no socket. */ }
  // Only a reverse proxy on this machine may speak for the client, and the entry it appended is the last one.
  const forwarded = peer && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return clientKey(forwarded && isIP(forwarded) ? forwarded : peer);
}

/** What goes to the server log. Errors raised by a library can quote a mail server's answer, addresses included, so only their type and origin are kept. */
function describe(error: unknown) {
  if (!(error instanceof Error)) return typeof error;
  if ([TypeError, RangeError, ReferenceError, SyntaxError].some(type => error instanceof type)) return error.stack ?? error.message;
  const code = (error as { code?: unknown }).code;
  return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}\n${(error.stack ?? '').split('\n').filter(line => line.trimStart().startsWith('at ')).slice(0, 5).join('\n')}`;
}
