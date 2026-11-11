import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { accountSchema, accountUpdateSchema, composeSchema, discoverySchema, draftSchema, flagsSchema, listSchema, loginSchema, MAX_ATTACHMENT_BYTES, moveSchema, sendSchema, type SyncEvent } from '@mail/shared';
import { discoverAccount, publicError, verifyPassword, type MailService } from '@mail/core';
import { oauthStartSchema, oauthProviderSchema, oauthClientUpdateSchema, oauthCallbackSchema } from '@mail/shared';
import { createAccessPolicy } from './access';
import { SESSION_SECONDS, WebSessions } from './sessions';

type Options = { service: MailService; passwordHash: string; port: number; webRoot?: string; docsRoot?: string; dev?: boolean; publicUrl?: string; https?: boolean };

export function createApp({ service, passwordHash, port, webRoot, docsRoot = resolve('docs'), dev = false, publicUrl, https = false }: Options) {
  const app = new Hono<{ Variables: { secureCookie: boolean } }>();
  const sessions = new WebSessions(service.store);
  const sessionEvents = new EventEmitter();
  const access = createAccessPolicy({ port, publicUrl, https, dev });
  let loginAttempts = 0;
  let loginWindow = Date.now();
  const authenticated = (token: string | undefined) => sessions.authenticated(token);

  app.use('*', async (c, next) => {
    const expectedOrigin = access.originForHost(c.req.header('host') ?? new URL(c.req.url).host);
    if (!expectedOrigin) return c.json({ error: '不允许的 Host；使用域名访问时请设置 MAIL_PUBLIC_URL' }, 403);
    const origin = c.req.header('origin');
    if (origin && !access.acceptsOrigin(expectedOrigin, origin)) return c.json({ error: '不允许的请求来源' }, 403);
    if (c.req.path.startsWith('/api/') && c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: '不允许跨站请求' }, 403);
    if (!['GET', 'HEAD'].includes(c.req.method) && !origin) return c.json({ error: '请求缺少 Origin' }, 403);
    c.set('secureCookie', expectedOrigin.startsWith('https:'));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024, onError: c => c.json({ error: '请求内容过大' }, 413) }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (['/api/session', '/api/login'].includes(c.req.path)) return next();
    if (!authenticated(getCookie(c, 'mail_session'))) return c.json({ error: '请先登录' }, 401);
    await next();
  });
  app.get('/api/session', c => c.json({ authenticated: authenticated(getCookie(c, 'mail_session')) }));
  app.post('/api/login', async c => {
    const parsed = loginSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
    if (Date.now() - loginWindow > 60_000) { loginWindow = Date.now(); loginAttempts = 0; }
    if (++loginAttempts > 10) return c.json({ error: '登录尝试过于频繁，请一分钟后重试' }, 429);
    if (!await verifyPassword(parsed.data.password, passwordHash)) return c.json({ error: '密码不正确' }, 401);
    loginAttempts = 0;
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
  app.get('/api/oauth/clients', c => c.json(service.oauth.settings()));
  app.put('/api/oauth/clients/:provider', async c => {
    const provider = oauthProviderSchema.safeParse(c.req.param('provider'));
    const input = oauthClientUpdateSchema.safeParse(await c.req.json());
    if (!provider.success || !input.success) return c.json({ error: 'OAuth 客户端设置不正确' }, 400);
    service.oauth.setClient(provider.data, input.data);
    return c.json(service.oauth.settings());
  });
  app.get('/api/oauth/docs/:provider', async c => {
    const provider = oauthProviderSchema.safeParse(c.req.param('provider'));
    if (!provider.success) return c.notFound();
    return c.text(await readFile(join(docsRoot, `oauth-${provider.data}.md`), 'utf8'));
  });
  app.post('/api/oauth/start', async c => {
    const parsed = oauthStartSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json(await service.oauthFlow.start(getCookie(c, 'mail_session')!, parsed.data), 201);
  });
  app.get('/api/oauth/sessions/:id', c => c.json(service.oauthFlow.status(c.req.param('id'), getCookie(c, 'mail_session')!)));
  app.post('/api/oauth/sessions/:id/callback', async c => {
    const parsed = oauthCallbackSchema.safeParse(await c.req.json());
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
    if (!service.store.account(c.req.param('id'))) return c.json({ error: '邮箱不存在' }, 404);
    const parsed = accountUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }, 400);
    const oauth = service.accountSettings(c.req.param('id')).oauth;
    if (oauth) {
      const oauthInput = oauthStartSchema.safeParse({ accountId: c.req.param('id'), account: parsed.data, provider: oauth.provider, client: { source: 'saved' } });
      if (!oauthInput.success) return c.json({ error: oauthInput.error.issues[0].message }, 400);
    }
    await service.updateAccount(c.req.param('id'), parsed.data);
    return c.json({ ok: true });
  });
  app.post('/api/autoconfig', async c => {
    const parsed = discoverySchema.safeParse(await c.req.json());
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
    return c.body(new Uint8Array(file.content));
  });
  app.get('/api/drafts', c => c.json(service.store.drafts(c.req.query('accountId'))));
  app.get('/api/drafts/:id', c => {
    if (!service.store.draft(c.req.param('id'))) return c.json({ error: '草稿不存在' }, 404);
    return c.json(service.getDraft(c.req.param('id')));
  });
  app.post('/api/drafts', async c => {
    const parsed = draftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: '草稿内容不正确，请检查长度和附件' }, 400);
    return c.json(await service.saveDraft(undefined, parsed.data), 201);
  });
  app.put('/api/drafts/:id', async c => {
    if (!service.store.draft(c.req.param('id'))) return c.json({ error: '草稿不存在' }, 404);
    const parsed = draftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: '草稿内容不正确，请检查长度和附件' }, 400);
    return c.json(await service.saveDraft(c.req.param('id'), parsed.data));
  });
  app.delete('/api/drafts/:id', async c => {
    if (!service.store.draft(c.req.param('id'))) return c.json({ error: '草稿不存在' }, 404);
    await service.deleteDraft(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/accounts', async c => {
    const parsed = accountSchema.safeParse(await c.req.json());
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
  app.get('/api/folders', c => c.json(service.store.folders()));
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
  app.get('/api/messages/:id/thread', c => c.json(service.store.thread(service.store.message(c.req.param('id'))!.threadId)));
  app.post('/api/messages/:id/draft', async c => {
    const parsed = composeSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: '写信操作不正确' }, 400);
    return c.json(await service.compose(c.req.param('id'), parsed.data.mode, parsed.data.includeAttachments, parsed.data.timeZone), 201);
  });
  app.patch('/api/messages/:id/flags', async c => {
    const parsed = flagsSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: '标记参数不正确' }, 400);
    await service.flags(c.req.param('id'), parsed.data);
    return c.json({ ok: true });
  });
  app.post('/api/messages/:id/move', async c => {
    const parsed = moveSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: '文件夹参数不正确' }, 400);
    await service.move(c.req.param('id'), parsed.data.folderId);
    return c.json({ ok: true });
  });
  app.get('/api/messages/:id/attachments/:attachmentId', async c => {
    const body = await service.body(c.req.param('id'));
    const attachment = body.attachments.find(item => item.id === c.req.param('attachmentId'));
    if (!attachment) return c.json({ error: '附件不存在' }, 404);
    const content = await service.cache.attachment(c.req.param('id'), attachment.id);
    c.header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/'/g, '%27')}`);
    c.header('Content-Type', 'application/octet-stream');
    return c.body(new Uint8Array(content));
  });
  app.post('/api/send', async c => {
    const parsed = sendSchema.safeParse(await c.req.json());
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
    if (error instanceof SyntaxError) return c.json({ error: '请求不是有效的 JSON' }, 400);
    return c.json({ error: publicError(error) }, 502);
  });
  return app;
}
