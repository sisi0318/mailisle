import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { MailStore } from '@mail/db';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type AccountSettings, type AccountUpdate, type AccountVerification, type ComposeMode, type Draft, type DraftInput, type FlagUpdate, type MessageBody, type SendInput, type SyncEvent } from '@mail/shared';
import type { MailAdapter } from './adapter';
import { ImapAdapter } from './imap';
import { Vault } from './crypto';
import { BodyCache } from './cache';
import { BodyPrefetcher } from './body-prefetcher';
import { UploadStore } from './uploads';
import { composeDraft } from './compose';
import { OAuthManager, type AccountConfig } from './oauth';
import { OAuthFlow } from './oauth-flow';
import { publicError, UserError } from './errors';
import { proxyDisplay } from './proxy';

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
  private nextCleanup = 0;
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
      for (const account of this.store.accounts()) if (account.receiveEnabled) void this.sync(account.id);
      if (Date.now() >= this.nextCleanup) {
        this.nextCleanup = Date.now() + 3_600_000;
        void this.uploads?.cleanup().catch(error => console.warn('临时附件清理失败', publicError(error)));
        // Mail removed on the server leaves its cached body behind, and nothing else would ever delete it.
        void this.cache.sweep(id => this.store.hasMessage(id)).catch(error => console.warn('邮件缓存清理失败', publicError(error)));
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
    config = { ...config, ...this.oauth.proxies.prepare(config) };
    let id: string | undefined;
    const adapter = this.makeAdapter(config, () => id);
    try {
      const folders = await this.verifyAccount(adapter, config);
      id = this.store.addAccount(config.name, config.email, this.vault.encrypt(config), config);
      if (config.receiveEnabled) this.store.saveFolders(id, folders);
      this.adapters.set(id, adapter);
      void this.sync(id);
      return id;
    } catch (error) { await adapter.close(); throw error; }
  }
  async deleteAccount(id: string) {
    const attachments = this.store.drafts(id).flatMap(draft => this.store.draft(draft.id)!.attachmentIds);
    this.beginAccountChange(id);
    let cached: string[] = [];
    try { await this.pauseAccount(id); cached = this.store.messageIds(id); this.store.deleteAccount(id); }
    finally { this.changingAccounts.delete(id); }
    await this.cleanupUploads(attachments);
    await this.cleanupBodies(cached);
    // A sync that was cut short never reports its own end.
    this.emit({ type: 'sync', accountId: id, state: 'idle' });
    this.emit({ type: 'change', accountId: id });
  }
  reorderAccounts(ids: string[]) {
    const current = new Set(this.store.accounts().map(account => account.id));
    if (current.size !== ids.length || ids.some(id => !current.has(id))) throw new UserError('邮箱列表已变化，请刷新后重试', 409);
    this.store.reorderAccounts(ids);
    this.emit({ type: 'change', accountId: ids[0] });
  }
  async setGlobalProxy(value: string | null) {
    const affected = this.store.accounts().filter(account => this.oauth.proxies.mode(this.accountConfig(account.id)) === 'global');
    if (affected.some(account => this.changingAccounts.has(account.id))) throw new UserError('有邮箱正在修改设置，请稍后重试', 409);
    this.oauth.proxies.save(value);
    for (const account of affected) this.beginAccountChange(account.id);
    try { await Promise.all(affected.map(account => this.pauseAccount(account.id))); }
    finally {
      for (const account of affected) {
        this.changingAccounts.delete(account.id);
        this.emit({ type: 'change', accountId: account.id });
        void this.sync(account.id);
      }
    }
    this.emit({ type: 'settings' });
    return this.oauth.proxies.settings();
  }
  accountSettings(id: string): AccountSettings {
    const config = this.accountConfig(id);
    const { password: _imapPassword, ...imap } = config.imap;
    const { password: _smtpPassword, ...smtp } = config.smtp;
    return { name: config.name, email: config.email, sentCopy: config.sentCopy, imap, smtp,
      receiveEnabled: config.receiveEnabled, sendEnabled: config.sendEnabled,
      ...(config.oauth ? { oauth: { provider: config.oauth.provider, client: { source: config.oauth.client.source, clientId: config.oauth.client.clientId, hasSecret: !!config.oauth.client.clientSecret } } } : {}),
      proxyMode: this.oauth.proxies.mode(config), proxyDisplay: proxyDisplay(config.proxy), globalProxyDisplay: this.oauth.proxies.settings().display };
  }
  async updateAccount(id: string, input: AccountUpdate) {
    const config = this.updatedAccountConfig(id, input);
    await this.replaceAccount(id, config, !!config.oauth);
  }
  async verifyAccountSettings(id: string, input: AccountUpdate): Promise<AccountVerification> {
    const config = this.updatedAccountConfig(id, input);
    const adapter = this.makeAdapter(config, () => id);
    const result: AccountVerification = { imap: { status: 'disabled' }, smtp: { status: 'disabled' } };
    try {
      await Promise.all((['imap', 'smtp'] as const).map(async protocol => {
        if (!(protocol === 'imap' ? config.receiveEnabled : config.sendEnabled)) return;
        try {
          if (protocol === 'imap') { await adapter.connect(); await adapter.listFolders(); }
          else await adapter.verifySmtp();
          result[protocol] = { status: 'success' };
        } catch (error) { result[protocol] = { status: 'error', error: publicError(error) }; }
      }));
      return result;
    } finally { await adapter.close(); }
  }
  async saveOAuthAccount(config: AccountConfig, id?: string) {
    if (!id) return this.addAccount(config);
    await this.replaceAccount(id, { ...config, ...this.oauth.proxies.prepare(config, this.accountConfig(id)) });
    return id;
  }
  private async replaceAccount(id: string, config: AccountConfig, keepOAuth = false) {
    const old = this.accountConfig(id);
    let cached: string[] = [];
    this.beginAccountChange(id);
    try {
      await this.pauseAccount(id);
      if (keepOAuth) config.oauth = this.accountConfig(id).oauth;
      const reset = old.imap.host !== config.imap.host || old.imap.port !== config.imap.port || old.imap.user !== config.imap.user;
      if (reset) cached = this.store.messageIds(id);
      this.store.updateAccount(id, config.name, config.email, this.vault.encrypt(config), reset, config);
    } finally { this.changingAccounts.delete(id); void this.sync(id); }
    await this.cleanupBodies(cached);
    this.emit({ type: 'change', accountId: id });
  }
  sync(id: string): Promise<void> {
    if (this.stopped || this.changingAccounts.has(id) || this.store.account(id)?.receiveEnabled === false) return Promise.resolve();
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
  async markAllRead(accountId: string, folderId?: string) {
    const folder = folderId ? this.store.folder(folderId) : undefined;
    if (folderId && (!folder || folder.accountId !== accountId)) throw new UserError('文件夹不存在或不属于这个邮箱', 404);
    try {
      await this.withAdapter(accountId, async adapter => {
        const targets = folder ? [folder] : this.store.saveFolders(accountId, await adapter.listFolders());
        for (const target of targets) {
          const checkpoint = await adapter.markAllRead(target);
          if (this.store.folder(target.id)?.uidValidity === checkpoint.uidValidity) this.store.markFolderRead(target.id, checkpoint.uidNext);
        }
      });
    } finally { this.emit({ type: 'change', accountId }); void this.sync(accountId); }
  }
  async createFolder(accountId: string, name: string, parentId?: string) {
    const parent = parentId ? this.store.folder(parentId) : undefined;
    if (parentId && (!parent || parent.accountId !== accountId)) throw new UserError('上级文件夹不存在或不属于这个邮箱', 404);
    const path = await this.withAdapter(accountId, async adapter => {
      const created = await adapter.createFolder(name, parent);
      this.store.saveFolders(accountId, await adapter.listFolders());
      return created;
    });
    this.emit({ type: 'change', accountId }); void this.sync(accountId);
    return this.store.folders(accountId).find(folder => folder.path === path);
  }
  async deleteFolder(id: string) {
    const folder = this.store.folder(id);
    if (!folder) throw new UserError('文件夹不存在', 404);
    if (folder.role !== 'other') throw new UserError('不能删除系统文件夹', 400);
    const config = this.accountConfig(folder.accountId);
    if (!config.receiveEnabled) throw new UserError('请先在邮箱设置中开启收信', 409);
    this.beginAccountChange(folder.accountId);
    const adapter = this.makeAdapter(config, () => folder.accountId);
    try {
      // Stop active scans before removing folders they may still be writing into.
      await this.pauseAccount(folder.accountId);
      await adapter.connect();
      try { await adapter.deleteFolder(folder); }
      finally { this.store.saveFolders(folder.accountId, await adapter.listFolders()); }
    } finally {
      await adapter.close();
      this.changingAccounts.delete(folder.accountId);
      this.emit({ type: 'change', accountId: folder.accountId });
      void this.sync(folder.accountId);
    }
  }
  async send(input: SendInput) {
    if (input.draftId && this.store.draft(input.draftId)?.accountId !== input.accountId) throw new Error('草稿不存在或发件人已改变，请先保存草稿');
    const attachments = input.attachmentIds.length ? await this.requireUploads().attachments(input.attachmentIds) : [];
    const sent = this.store.folders(input.accountId).find(folder => folder.role === 'sent');
    const result = await this.withAdapter(input.accountId, adapter => adapter.send(input, sent?.path, attachments), 'send');
    try { if (input.draftId) await this.deleteDraft(input.draftId); }
    catch { result.warning = [result.warning, '邮件已发送，但清理草稿失败，请勿重复发送。'].filter(Boolean).join(' '); }
    await this.cleanupUploads(input.attachmentIds);
    void this.sync(input.accountId);
    return result;
  }
  getDraft(id: string): Draft {
    const draft = this.store.draft(id);
    if (!draft) throw new UserError('草稿不存在', 404);
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
    const body = await this.cache.stored(id) ?? await this.body(id);
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
  /** One attachment with its bytes. Reads only that file, not the inline images a full body carries. */
  async attachment(messageId: string, attachmentId: string) {
    this.requireMessage(messageId);
    const body = await this.cache.stored(messageId) ?? await this.body(messageId);
    const attachment = body.attachments.find(item => item.id === attachmentId);
    if (!attachment) throw new UserError('附件不存在', 404);
    return { ...attachment, content: await this.cache.attachment(messageId, attachmentId) };
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
    // Folders that could not be synced. The others still are, so one broken folder does not hold up the whole mailbox.
    const failed: { stage: string; error: unknown }[] = [];
    let folderCount = 0;
    const report = (cause: { stage: string; error: unknown }, finished: boolean) => {
      const others = !finished ? '' : failed.length > 1 ? `；另有 ${failed.length - 1} 个文件夹也未同步` : folderCount > 1 ? '；其余文件夹已同步' : '';
      const message = `${cause.stage}失败：${publicError(cause.error)}${others}`;
      this.store.syncStatus(id, message);
      this.emit({ type: 'sync', accountId: id, state: 'error', error: message });
    };
    try {
      await this.withAdapter(id, async adapter => {
        stage = '读取文件夹列表';
        const folders = this.store.saveFolders(id, await adapter.listFolders());
        folderCount = folders.length;
        for (const listed of folders) {
          if (this.stopped || this.changingAccounts.has(id)) return;
          const folder = this.store.folder(listed.id)!;
          // The failure may have cost the connection. If it cannot be reopened, the round ends here.
          if (failed.length) { stage = '重新连接邮箱'; await adapter.connect(); }
          stage = `同步文件夹「${folder.name}」`;
          try {
            const { cursor, uids } = await adapter.sync(folder, {
              knownUids: this.store.folderUids(folder.id),
              begin: validity => this.store.beginFolder(folder.id, validity),
              messages: records => this.store.applyBatch(this.store.folder(folder.id)!, records),
              flags: records => this.store.applyFlags(folder.id, records),
            });
            this.store.finishFolder(folder.id, cursor, uids);
            this.emit({ type: 'change', accountId: id });
          } catch (error) {
            if (this.stopped || this.changingAccounts.has(id)) return;
            failed.push({ stage, error });
          }
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
      if (failed.length) report(failed[0], true);
      else {
        this.store.syncStatus(id, null);
        this.emit({ type: 'sync', accountId: id, state: 'idle' });
      }
      void this.prefetcher.schedule(id);
    } catch (error) {
      if (this.stopped || this.changingAccounts.has(id)) return;
      // What went wrong first is the more useful thing to show than the reconnect that failed after it.
      report(failed[0] ?? { stage, error }, false);
    }
  }
  private async drainSync(id: string) {
    do {
      this.pendingSync.delete(id);
      await this.syncAccount(id);
    } while (!this.stopped && !this.changingAccounts.has(id) && this.pendingSync.has(id));
  }
  private async withAdapter<T>(id: string, action: (adapter: MailAdapter) => Promise<T>, channel: 'receive' | 'send' = 'receive'): Promise<T> {
    if (this.stopped) throw new UserError('邮件服务正在关闭', 503);
    if (this.changingAccounts.has(id)) throw new UserError('邮箱配置正在更新，请稍后重试', 409);
    const account = this.store.account(id);
    if (!account) throw new UserError('账号不存在', 404);
    if (!(channel === 'receive' ? account.receiveEnabled : account.sendEnabled)) throw new UserError(`此邮箱已关闭${channel === 'receive' ? '收信' : '发信'}，请在邮箱设置中开启`, 409);
    let adapter = this.adapters.get(id);
    if (!adapter) {
      adapter = this.makeAdapter(this.accountConfig(id), () => id);
      this.adapters.set(id, adapter);
    }
    const operations = this.operations.get(id) ?? new Set<Promise<unknown>>();
    this.operations.set(id, operations);
    const work = (channel === 'receive' ? adapter.connect() : Promise.resolve()).then(() => action(adapter));
    operations.add(work);
    try { return await work; }
    finally { operations.delete(work); if (!operations.size) this.operations.delete(id); }
  }
  private accountConfig(id: string) {
    const account = this.store.account(id);
    if (!account) throw new UserError('邮箱不存在', 404);
    return { ...this.vault.decrypt<AccountConfig>(account.encryptedConfig), receiveEnabled: account.receiveEnabled, sendEnabled: account.sendEnabled };
  }
  private updatedAccountConfig(id: string, input: AccountUpdate): AccountConfig {
    const old = this.accountConfig(id);
    if (!input.receiveEnabled && !input.imap.host) input = { ...input, imap: { ...old.imap, password: undefined } };
    if (!input.sendEnabled && !input.smtp.host) input = { ...input, smtp: { ...old.smtp, password: undefined } };
    if (old.oauth && (input.imap.password || input.smtp.password)) throw new UserError('OAuth 邮箱不使用密码，请在高级设置中重新授权');
    // A stored password only ever goes to the server it was entered for.
    for (const protocol of ['imap', 'smtp'] as const) {
      if (!old.oauth && !input[protocol].password && old[protocol].host.trim().toLowerCase() !== input[protocol].host.trim().toLowerCase())
        throw new UserError(`更换${protocol === 'imap' ? '收信' : '发信'}服务器后需要重新填写密码，已保存的密码不会发往新的服务器`);
    }
    return { ...input, oauth: old.oauth,
      imap: { ...input.imap, password: input.imap.password ?? old.imap.password },
      smtp: { ...input.smtp, password: input.smtp.password ?? old.smtp.password },
      ...this.oauth.proxies.prepare(input, old) };
  }
  private async verifyAccount(adapter: MailAdapter, config: AccountConfig) {
    if (config.receiveEnabled) { await adapter.connect(); return adapter.listFolders(); }
    await adapter.verifySmtp();
    return [];
  }
  private makeAdapter(config: AccountConfig, accountId: () => string | undefined) {
    const connected = { ...config, proxy: this.oauth.proxies.resolve(config) };
    return this.adapterFactory(connected, config.oauth ? () => this.oauth.accessToken(config, accountId()) : undefined);
  }
  private beginAccountChange(id: string) {
    if (this.changingAccounts.has(id)) throw new UserError('邮箱配置正在更新，请稍后重试', 409);
    this.changingAccounts.add(id);
  }
  private async pauseAccount(id: string) {
    this.watchers.get(id)?.(); this.watchers.delete(id);
    await this.prefetcher.cancel(id);
    // Closing first ends whatever is in flight. Waiting for a large folder to finish could hold the request for minutes.
    await this.adapters.get(id)?.close();
    await Promise.allSettled([...(this.operations.get(id) ?? []), ...(this.running.has(id) ? [this.running.get(id)!] : [])]);
    this.adapters.delete(id); this.pendingSync.delete(id);
  }
  private requireUploads() {
    if (!this.uploads) throw new UserError('附件存储未配置', 503);
    return this.uploads;
  }
  private async cleanupBodies(ids: string[]) {
    try { await this.cache.remove(ids); }
    catch (error) { console.warn('邮件缓存清理失败', publicError(error)); }
  }
  private async cleanupUploads(ids: string[]) {
    try { if (ids.length) await this.requireUploads().removeUnused(ids); }
    catch (error) { console.warn('临时附件清理失败', publicError(error)); }
  }
  private requireMessage(id: string) {
    const message = this.store.message(id);
    if (!message) throw new UserError('邮件不存在', 404);
    return message;
  }
  private emit(event: SyncEvent) { this.events.emit('update', event); }
}
