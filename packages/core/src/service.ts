import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { MailStore } from '@mail/db';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type AccountSettings, type AccountUpdate, type ComposeMode, type Draft, type DraftInput, type FlagUpdate, type MessageBody, type SendInput, type SyncEvent } from '@mail/shared';
import type { MailAdapter } from './adapter';
import { ImapAdapter } from './imap';
import { Vault } from './crypto';
import { BodyCache } from './cache';
import { BodyPrefetcher } from './body-prefetcher';
import { UploadStore } from './uploads';
import { composeDraft } from './compose';
import { OAuthManager, type AccountConfig } from './oauth';
import { OAuthFlow } from './oauth-flow';

export class MailService {
  readonly events = new EventEmitter();
  private running = new Map<string, Promise<void>>();
  private pendingSync = new Set<string>();
  private adapters = new Map<string, MailAdapter>();
  private watchers = new Map<string, () => void>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private prefetcher: BodyPrefetcher;
  private bodyLoads = new Map<string, { accountId: string; promise: Promise<MessageBody> }>();
  private changingAccounts = new Set<string>();
  private operations = new Map<string, Set<Promise<unknown>>>();
  private nextUploadCleanup = 0;
  readonly oauth: OAuthManager;
  readonly oauthFlow: OAuthFlow;

  constructor(readonly store: MailStore, private vault: Vault, readonly cache: BodyCache,
    private adapterFactory: (config: AccountConfig, accessToken?: () => Promise<string>) => MailAdapter = (config, token) => new ImapAdapter(config, undefined, token), readonly uploads?: UploadStore,
    oauth = new OAuthManager(store, vault)) {
    this.oauth = oauth;
    this.oauthFlow = new OAuthFlow(oauth);
    this.prefetcher = new BodyPrefetcher(store, cache,
      id => this.makeAdapter(this.accountConfig(id), () => id), {
        change: accountId => this.emit({ type: 'change', accountId, contentOnly: true }),
        error: (accountId, error) => console.warn('正文预取未完成，将在下次同步后重试', accountId, publicError(error)),
      });
  }

  start(interval = 60_000) {
    this.stopped = false;
    this.prefetcher.start();
    const tick = () => {
      for (const account of this.store.accounts()) void this.sync(account.id);
      if (this.uploads && Date.now() >= this.nextUploadCleanup) {
        this.nextUploadCleanup = Date.now() + 3_600_000;
        void this.uploads.cleanup().catch(error => console.warn('临时附件清理失败', publicError(error)));
      }
    };
    tick();
    this.timer = setInterval(tick, interval);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.oauthFlow.close();
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    await this.prefetcher.stop();
    await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close()));
    await Promise.allSettled([...this.running.values(), ...[...this.bodyLoads.values()].map(load => load.promise), ...[...this.operations.values()].flatMap(operations => [...operations])]);
    this.adapters.clear();
    this.pendingSync.clear();
  }
  async addAccount(config: AccountConfig) {
    let id: string | undefined;
    const adapter = this.makeAdapter(config, () => id);
    try {
      await adapter.connect();
      const folders = await adapter.listFolders();
      await adapter.verifySmtp();
      id = this.store.addAccount(config.name, config.email, this.vault.encrypt(config));
      this.store.saveFolders(id, folders);
      this.adapters.set(id, adapter);
      void this.sync(id);
      return id;
    } catch (error) { await adapter.close(); throw error; }
  }
  async deleteAccount(id: string) {
    const attachments = this.store.drafts(id).flatMap(draft => this.store.draft(draft.id)!.attachmentIds);
    this.beginAccountChange(id);
    try { await this.pauseAccount(id); this.store.deleteAccount(id); }
    finally { this.changingAccounts.delete(id); }
    await this.cleanupUploads(attachments);
    this.emit({ type: 'change', accountId: id });
  }
  accountSettings(id: string): AccountSettings {
    const config = this.accountConfig(id);
    const { password: _imapPassword, ...imap } = config.imap;
    const { password: _smtpPassword, ...smtp } = config.smtp;
    const proxy = config.proxy ? new URL(config.proxy) : undefined;
    return { name: config.name, email: config.email, sentCopy: config.sentCopy, imap, smtp,
      ...(config.oauth ? { oauth: { provider: config.oauth.provider, client: { source: config.oauth.client.source, clientId: config.oauth.client.clientId, hasSecret: !!config.oauth.client.clientSecret } } } : {}),
      ...(proxy ? { proxyDisplay: `${proxy.protocol}//${proxy.host}` } : {}) };
  }
  async updateAccount(id: string, input: AccountUpdate) {
    const old = this.accountConfig(id);
    if (old.oauth && (input.imap.password || input.smtp.password)) throw new Error('OAuth 邮箱不使用密码，请点击重新授权');
    const config: AccountConfig = { ...input, oauth: old.oauth,
      imap: { ...input.imap, password: input.imap.password ?? old.imap.password },
      smtp: { ...input.smtp, password: input.smtp.password ?? old.smtp.password },
      proxy: input.proxy === undefined ? old.proxy : input.proxy || undefined };
    return this.replaceAccount(id, config, !!old.oauth);
  }
  async saveOAuthAccount(config: AccountConfig, id?: string) {
    if (!id) return this.addAccount(config);
    await this.replaceAccount(id, config);
    return id;
  }
  private async replaceAccount(id: string, config: AccountConfig, keepOAuth = false) {
    const old = this.accountConfig(id);
    let saved = false;
    const adapter = this.makeAdapter(config, () => saved || keepOAuth ? id : undefined);
    this.beginAccountChange(id);
    try {
      await adapter.connect(); await adapter.listFolders(); await adapter.verifySmtp();
      await this.pauseAccount(id);
      if (keepOAuth) config.oauth = this.accountConfig(id).oauth;
      const reset = old.imap.host !== config.imap.host || old.imap.port !== config.imap.port || old.imap.user !== config.imap.user;
      this.store.updateAccount(id, config.name, config.email, this.vault.encrypt(config), reset);
      saved = true;
      this.adapters.set(id, adapter);
    } catch (error) { await adapter.close(); throw error; }
    finally { this.changingAccounts.delete(id); void this.sync(id); }
    this.emit({ type: 'change', accountId: id });
  }
  sync(id: string): Promise<void> {
    if (this.stopped || this.changingAccounts.has(id)) return Promise.resolve();
    if (this.running.has(id)) {
      this.pendingSync.add(id);
      return this.running.get(id)!;
    }
    const work = this.drainSync(id).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }
  async body(id: string) {
    const cached = await this.cache.read(id);
    if (cached) {
      // Old CID caches stay immediately readable, including offline, while metadata upgrades in the background.
      if (cached.cacheVersion !== 2 && /cid:/i.test(cached.html ?? '')) void this.loadBody(id, true).catch(() => {});
      return cached;
    }
    return this.loadBody(id);
  }
  async flags(id: string, update: FlagUpdate) {
    const message = this.requireMessage(id);
    await this.withAdapter(message.accountId, async adapter => {
      try {
        for (const location of this.store.messageLocations(id)) {
          await adapter.flags(location.folder, location.uid, update);
          this.store.patchFlags(location.folder.id, location.uid, update);
        }
      } finally { this.emit({ type: 'change', accountId: message.accountId }); }
    });
  }
  async move(id: string, folderId: string) {
    const message = this.requireMessage(id);
    const target = this.store.folder(folderId);
    if (!target || target.accountId !== message.accountId) throw new Error('目标文件夹必须属于同一账号');
    const location = this.store.messageLocations(id).find(item => item.folder.id !== folderId);
    if (!location) throw new Error('邮件已在目标文件夹中');
    await this.withAdapter(message.accountId, async adapter => {
      const receipt = await adapter.move(location.folder, location.uid, target.path);
      const mapped = this.store.moveLocation(location.folder.id, location.uid, target, receipt);
      this.emit({ type: 'change', accountId: message.accountId });
      if (!mapped) void this.sync(message.accountId);
    });
  }
  async send(input: SendInput) {
    if (input.draftId && this.store.draft(input.draftId)?.accountId !== input.accountId) throw new Error('草稿不存在或发件人已改变，请先保存草稿');
    const attachments = input.attachmentIds.length ? await this.requireUploads().attachments(input.attachmentIds) : [];
    const sent = this.store.folders(input.accountId).find(folder => folder.role === 'sent');
    const result = await this.withAdapter(input.accountId, adapter => adapter.send(input, sent?.path, attachments));
    try {
      if (input.draftId) await this.deleteDraft(input.draftId);
      await this.cleanupUploads(input.attachmentIds);
    } catch {
      result.warning = [result.warning, '邮件已发送，但清理草稿失败，请勿重复发送。'].filter(Boolean).join(' ');
    }
    void this.sync(input.accountId);
    return result;
  }
  getDraft(id: string): Draft {
    const draft = this.store.draft(id);
    if (!draft) throw new Error('草稿不存在');
    return { ...draft, html: draft.html ?? undefined, inReplyTo: draft.inReplyTo ?? undefined,
      attachments: draft.attachmentIds.length ? this.requireUploads().metadata(draft.attachmentIds) : [] };
  }
  async saveDraft(id: string | undefined, input: DraftInput): Promise<Draft> {
    if (!this.store.account(input.accountId)) throw new Error('发件邮箱不存在');
    if (this.changingAccounts.has(input.accountId)) throw new Error('邮箱配置正在更新，请稍后保存草稿');
    const previous = id ? this.getDraft(id) : undefined;
    if (input.attachmentIds.length) this.requireUploads().metadata(input.attachmentIds);
    id ??= randomUUID();
    this.store.saveDraft(id, input);
    await this.cleanupUploads(previous?.attachmentIds ?? []);
    this.emit({ type: 'draft', accountId: input.accountId });
    return this.getDraft(id);
  }
  async deleteDraft(id: string) {
    const draft = this.getDraft(id);
    this.store.deleteDraft(id);
    await this.cleanupUploads(draft.attachmentIds);
    this.emit({ type: 'draft', accountId: draft.accountId });
  }
  async compose(id: string, mode: ComposeMode, includeAttachments: boolean, timeZone = 'UTC'): Promise<Draft> {
    const message = this.requireMessage(id);
    const body = await this.body(id);
    let cc = body.cc ?? [];
    if (mode === 'reply-all' && body.cc === undefined) {
      const location = this.store.messageLocations(id)[0];
      if (!location) throw new Error('原邮件已不存在');
      cc = await this.withAdapter(message.accountId, adapter => adapter.copyRecipients(location.folder, location.uid));
    }
    const draft = composeDraft(message, body, cc, mode, this.store.accounts(), timeZone);
    try {
      if (mode === 'forward' && includeAttachments) {
        const files = body.attachments;
        if (files.length > MAX_ATTACHMENTS || files.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('原邮件附件超过限制，请选择不带附件转发');
        for (const file of files) draft.attachmentIds.push((await this.requireUploads().save(file.filename, file.mimeType, await this.cache.attachment(id, file.id))).id);
      }
      return await this.saveDraft(undefined, draft);
    } catch (error) { await this.cleanupUploads(draft.attachmentIds); throw error; }
  }
  private async loadBody(id: string, notifyReader = false): Promise<MessageBody> {
    const existing = this.bodyLoads.get(id);
    if (existing) return existing.promise;
    const message = this.requireMessage(id);
    const location = this.store.messageLocations(id)[0];
    if (!location) throw new Error('邮件已被删除');
    const promise = this.withAdapter(message.accountId, async adapter => {
      const source = await adapter.source(location.folder, location.uid);
      const body = await this.cache.save(id, source);
      this.store.cacheBody(id, body.text);
      this.emit({ type: 'change', accountId: message.accountId, contentOnly: true, ...(notifyReader ? { messageId: id } : {}) });
      return body;
    }).finally(() => this.bodyLoads.delete(id));
    this.bodyLoads.set(id, { accountId: message.accountId, promise });
    return promise;
  }
  private async syncAccount(id: string) {
    if (this.stopped || this.changingAccounts.has(id) || !this.store.account(id)) return;
    this.emit({ type: 'sync', accountId: id, state: 'running' });
    let stage = '连接邮箱';
    try {
      await this.withAdapter(id, async adapter => {
        stage = '读取文件夹列表';
        const folders = this.store.saveFolders(id, await adapter.listFolders());
        for (const listed of folders) {
          if (this.stopped || this.changingAccounts.has(id)) return;
          const folder = this.store.folder(listed.id)!;
          stage = `同步文件夹「${folder.name}」`;
          const { cursor, uids } = await adapter.sync(folder, {
            knownUids: this.store.folderUids(folder.id),
            begin: validity => this.store.beginFolder(folder.id, validity),
            messages: records => this.store.applyBatch(this.store.folder(folder.id)!, records),
            flags: records => this.store.applyFlags(folder.id, records),
          });
          this.store.finishFolder(folder.id, cursor, uids);
          this.emit({ type: 'change', accountId: id });
        }
        if (!this.stopped && !this.changingAccounts.has(id) && !this.watchers.has(id)) {
          try {
            const stop = await adapter.watchInbox(() => { void this.sync(id); }, () => {
              this.watchers.get(id)?.();
              this.watchers.delete(id);
            });
            if (this.stopped || this.changingAccounts.has(id)) stop(); else this.watchers.set(id, stop);
          } catch { /* Polling continues if the dedicated IDLE connection is unavailable. */ }
        }
      });
      if (this.stopped || this.changingAccounts.has(id)) return;
      this.store.syncStatus(id, null);
      this.emit({ type: 'sync', accountId: id, state: 'idle' });
      void this.prefetcher.schedule(id);
    } catch (error) {
      if (this.stopped || this.changingAccounts.has(id)) return;
      const message = `${stage}失败：${publicError(error)}`;
      this.store.syncStatus(id, message);
      this.emit({ type: 'sync', accountId: id, state: 'error', error: message });
    }
  }
  private async drainSync(id: string) {
    do {
      this.pendingSync.delete(id);
      await this.syncAccount(id);
    } while (!this.stopped && !this.changingAccounts.has(id) && this.pendingSync.has(id));
  }
  private async withAdapter<T>(id: string, action: (adapter: MailAdapter) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('邮件服务正在关闭');
    if (this.changingAccounts.has(id)) throw new Error('邮箱配置正在更新，请稍后重试');
    const account = this.store.account(id);
    if (!account) throw new Error('账号不存在');
    let adapter = this.adapters.get(id);
    if (!adapter) {
      adapter = this.makeAdapter(this.accountConfig(id), () => id);
      this.adapters.set(id, adapter);
    }
    const operations = this.operations.get(id) ?? new Set<Promise<unknown>>();
    this.operations.set(id, operations);
    const work = adapter.connect().then(() => action(adapter));
    operations.add(work);
    try { return await work; }
    finally { operations.delete(work); if (!operations.size) this.operations.delete(id); }
  }
  private accountConfig(id: string) {
    const account = this.store.account(id);
    if (!account) throw new Error('邮箱不存在');
    return this.vault.decrypt<AccountConfig>(account.encryptedConfig);
  }
  private makeAdapter(config: AccountConfig, accountId: () => string | undefined) {
    return this.adapterFactory(config, config.oauth ? () => this.oauth.accessToken(config, accountId()) : undefined);
  }
  private beginAccountChange(id: string) {
    if (this.changingAccounts.has(id)) throw new Error('邮箱配置正在更新，请稍后重试');
    this.changingAccounts.add(id);
  }
  private async pauseAccount(id: string) {
    this.watchers.get(id)?.(); this.watchers.delete(id);
    await this.prefetcher.cancel(id);
    await Promise.allSettled([...(this.operations.get(id) ?? []), ...(this.running.has(id) ? [this.running.get(id)!] : [])]);
    await this.adapters.get(id)?.close();
    this.adapters.delete(id); this.pendingSync.delete(id);
  }
  private requireUploads() {
    if (!this.uploads) throw new Error('附件存储未配置');
    return this.uploads;
  }
  private async cleanupUploads(ids: string[]) {
    try { if (ids.length) await this.requireUploads().removeUnused(ids); }
    catch (error) { console.warn('临时附件清理失败', publicError(error)); }
  }
  private requireMessage(id: string) {
    const message = this.store.message(id);
    if (!message) throw new Error('邮件不存在');
    return message;
  }
  private emit(event: SyncEvent) { this.events.emit('update', event); }
}

export function publicError(error: unknown): string {
  const details = error as { code?: string; authenticationFailed?: boolean } | undefined;
  const code = details?.code;
  if (error instanceof TypeError) return '客户端处理邮件时出错（TypeError），请反馈此问题';
  if (details?.authenticationFailed || code === 'EAUTH') return '邮箱登录未通过，请检查授权码或应用专用密码，以及 IMAP/SMTP 是否开启';
  if (code) return `邮件服务器连接失败（${code}），请检查网络、代理和账号配置`;
  // Remote server responses can contain usernames and credentials; keep them out of the UI.
  if (error instanceof Error && /^[\u3400-\u9fff]/.test(error.message)) return error.message;
  return '邮件操作未完成，请稍后重试';
}
