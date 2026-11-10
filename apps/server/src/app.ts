import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { accountSchema, flagsSchema, listSchema, loginSchema, moveSchema, sendSchema, type SyncEvent } from '@mail/shared';
import { publicError, verifyPassword, type MailService } from '@mail/core';

type Options = { service: MailService; passwordHash: string; port: number; webRoot?: string; dev?: boolean };

export function createApp({ service, passwordHash, port, webRoot, dev = false }: Options) {
  const app = new Hono();
  const sessions = new Map<string, number>();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...allowedHosts].map(host => `http://${host}`));
  if (dev) for (const host of ['127.0.0.1', 'localhost']) origins.add(`http://${host}:5173`);
  let loginAttempts = 0;
  let loginWindow = Date.now();
  const authenticated = (token: string | undefined) => !!token && (sessions.get(token) ?? 0) > Date.now();

  app.use('*', async (c, next) => {
    if (!allowedHosts.has(c.req.header('host') ?? new URL(c.req.url).host)) return c.json({ error: '不允许的 Host' }, 403);
    const origin = c.req.header('origin');
    if (origin && !origins.has(origin)) return c.json({ error: '不允许的请求来源' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: '不允许跨站请求' }, 403);
    if (!['GET', 'HEAD'].includes(c.req.method) && !origin) return c.json({ error: '请求缺少 Origin' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 12_000_000, onError: c => c.json({ error: '请求内容过大' }, 413) }));
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
    for (const [token, expires] of sessions) if (expires < Date.now()) sessions.delete(token);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 7 * 86_400_000);
    setCookie(c, 'mail_session', token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 7 * 86_400 });
    return c.json({ authenticated: true });
  });
  app.post('/api/logout', c => {
    sessions.delete(getCookie(c, 'mail_session') ?? '');
    deleteCookie(c, 'mail_session', { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/api/accounts', c => c.json(service.store.accounts()));
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
      const send = (event: SyncEvent) => { void stream.writeSSE({ event: 'update', data: JSON.stringify(event) }).catch(cleanup); };
      const heartbeat = setInterval(() => {
        if (!authenticated(token)) { cleanup(); return; }
        void stream.writeSSE({ event: 'ping', data: '{}' }).catch(cleanup);
      }, 15_000);
      function cleanup() { clearInterval(heartbeat); service.events.off('update', send); resolve(); }
      service.events.on('update', send);
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
