import { EventEmitter } from 'node:events';
import type { MailStore } from '@mail/db';
import type { AccountInput, FlagUpdate, SendInput, SyncEvent } from '@mail/shared';
import type { MailAdapter } from './adapter';
import { ImapAdapter } from './imap';
import { Vault } from './crypto';
import { BodyCache } from './cache';

export class MailService {
  readonly events = new EventEmitter();
  private running = new Map<string, Promise<void>>();
  private pendingSync = new Set<string>();
  private adapters = new Map<string, MailAdapter>();
  private watchers = new Map<string, () => void>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(readonly store: MailStore, private vault: Vault, readonly cache: BodyCache,
    private adapterFactory: (config: AccountInput) => MailAdapter = config => new ImapAdapter(config)) {}

  start(interval = 60_000) {
    this.stopped = false;
    const tick = () => { for (const account of this.store.accounts()) void this.sync(account.id); };
    tick();
    this.timer = setInterval(tick, interval);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close()));
    await Promise.allSettled(this.running.values());
    this.adapters.clear();
    this.pendingSync.clear();
  }
  async addAccount(config: AccountInput) {
    const adapter = this.adapterFactory(config);
    try {
      await adapter.connect();
      const folders = await adapter.listFolders();
      await adapter.verifySmtp();
      const id = this.store.addAccount(config.name, config.email, this.vault.encrypt(config));
      this.store.saveFolders(id, folders);
      this.adapters.set(id, adapter);
      void this.sync(id);
      return id;
    } catch (error) { await adapter.close(); throw error; }
  }
  async deleteAccount(id: string) {
    this.watchers.get(id)?.();
    this.watchers.delete(id);
    await this.running.get(id);
    this.watchers.get(id)?.();
    this.watchers.delete(id);
    await this.adapters.get(id)?.close();
    this.adapters.delete(id);
    this.pendingSync.delete(id);
    this.store.deleteAccount(id);
    this.emit({ type: 'change', accountId: id });
  }
  sync(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
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
    if (cached) return cached;
    const message = this.requireMessage(id);
    const location = this.store.messageLocations(id)[0];
    if (!location) throw new Error('邮件已被删除');
    return this.withAdapter(message.accountId, async adapter => {
      const source = await adapter.source(location.folder, location.uid);
      const body = await this.cache.save(id, source);
      this.store.cacheBody(id, body.text);
      return body;
    });
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
    const sent = this.store.folders(input.accountId).find(folder => folder.role === 'sent');
    const result = await this.withAdapter(input.accountId, adapter => adapter.send(input, sent?.path));
    void this.sync(input.accountId);
    return result;
  }
  private async syncAccount(id: string) {
    if (this.stopped || !this.store.account(id)) return;
    this.emit({ type: 'sync', accountId: id, state: 'running' });
    let stage = '连接邮箱';
    try {
      await this.withAdapter(id, async adapter => {
        stage = '读取文件夹列表';
        const folders = this.store.saveFolders(id, await adapter.listFolders());
        for (const listed of folders) {
          if (this.stopped) return;
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
        if (!this.stopped && !this.watchers.has(id)) {
          try {
            const stop = await adapter.watchInbox(() => { void this.sync(id); }, () => {
              this.watchers.get(id)?.();
              this.watchers.delete(id);
            });
            if (this.stopped) stop(); else this.watchers.set(id, stop);
          } catch { /* Polling continues if the dedicated IDLE connection is unavailable. */ }
        }
      });
      this.store.syncStatus(id, null);
      this.emit({ type: 'sync', accountId: id, state: 'idle' });
    } catch (error) {
      if (this.stopped) return;
      const message = `${stage}失败：${publicError(error)}`;
      this.store.syncStatus(id, message);
      this.emit({ type: 'sync', accountId: id, state: 'error', error: message });
    }
  }
  private async drainSync(id: string) {
    do {
      this.pendingSync.delete(id);
      await this.syncAccount(id);
    } while (!this.stopped && this.pendingSync.has(id));
  }
  private async withAdapter<T>(id: string, action: (adapter: MailAdapter) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('邮件服务正在关闭');
    const account = this.store.account(id);
    if (!account) throw new Error('账号不存在');
    let adapter = this.adapters.get(id);
    if (!adapter) {
      adapter = this.adapterFactory(this.vault.decrypt<AccountInput>(account.encryptedConfig));
      this.adapters.set(id, adapter);
    }
    await adapter.connect();
    return action(adapter);
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
