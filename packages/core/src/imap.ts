import { ImapFlow, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import * as socks from 'socks';
import PostalMime from 'postal-mime';
import type { AccountInput, Address, FlagUpdate, Folder, FolderRole, MailMetadata, SendInput } from '@mail/shared';
import type { MailAdapter, SyncSink } from './adapter';

export class ImapAdapter implements MailAdapter {
  private client: ImapFlow;
  private connecting?: Promise<void>;
  private connectionAttempted = false;
  constructor(private account: AccountInput) {
    this.client = this.newClient();
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.client.usable) return;
    if (this.connectionAttempted) {
      this.client.close();
      this.client = this.newClient();
    }
    this.connectionAttempted = true;
    this.connecting = this.client.connect().then(() => {}).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async verifySmtp() {
    const transport = this.smtp();
    try { await transport.verify(); }
    finally { transport.close(); }
  }
  async close() { this.client.close(); }
  async listFolders() {
    // IMAP flags are case-insensitive; QQ uses \\NoSelect for container folders.
    return (await this.client.list()).filter(folder => ![...folder.flags].some(flag => flag.toLowerCase() === '\\noselect')).map(folder => ({
      path: folder.path, name: folder.name, role: folderRole(folder.path, folder.specialUse),
    }));
  }
  async sync(folder: Folder, sink: SyncSink) {
    const lock = await this.client.getMailboxLock(folder.path);
    let cursor;
    let uids: number[];
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) throw new Error('无法打开文件夹');
      const uidValidity = mailbox.uidValidity.toString();
      cursor = { uidValidity, uidNext: mailbox.uidNext, modseq: mailbox.highestModseq?.toString() ?? null };
      const result = await this.client.search({ all: true }, { uid: true });
      if (result === false) throw new Error('邮件列表查询（SEARCH）未完成，已保留本地邮件索引，请稍后重试');
      if (result.length === 0 && mailbox.exists > 0) throw new Error('邮件列表查询（SEARCH）返回空列表，但服务器仍报告有邮件；已保留本地邮件索引');
      uids = result;
      sink.begin(uidValidity);
    } finally { lock.release(); }

    // Membership, rather than UIDNEXT alone, also finds older UIDs exposed by a changed server sync range.
    const known = new Set(folder.uidValidity === cursor.uidValidity ? sink.knownUids : []);
    const added = uids.filter(uid => !known.has(uid));
    const existing = uids.filter(uid => known.has(uid));
    const currentFolder = { ...folder, uidValidity: cursor.uidValidity };
    for (let i = 0; i < added.length; i += 200) {
      const batchLock = await this.lockCurrent(currentFolder);
      try {
        const fetched = await this.client.fetchAll(added.slice(i, i + 200), {
          uid: true, envelope: true, flags: true, internalDate: true, threadId: true,
          headers: ['references', 'in-reply-to'],
        }, { uid: true });
        const records = await Promise.all(fetched.map(metadata));
        if (records.length) sink.messages(records);
      } finally { batchLock.release(); }
    }
    const changedSince = folder.uidValidity === cursor.uidValidity && folder.modseq && cursor.modseq ? BigInt(folder.modseq) : undefined;
    for (let i = 0; i < existing.length; i += 200) {
      const batchLock = await this.lockCurrent(currentFolder);
      try {
        const fetched = await this.client.fetchAll(existing.slice(i, i + 200), { uid: true, flags: true }, { uid: true, changedSince });
        sink.flags(fetched.map(message => ({ uid: message.uid, flags: [...(message.flags ?? [])] })));
      } finally { batchLock.release(); }
    }
    return { cursor, uids };
  }
  async source(folder: Folder, uid: number) {
    const lock = await this.lockCurrent(folder);
    try {
      const message = await this.client.fetchOne(uid, { source: true }, { uid: true });
      if (!message || !message.source) throw new Error('邮件已不在服务器上，请同步后重试');
      return message.source;
    } finally { lock.release(); }
  }
  async flags(folder: Folder, uid: number, update: FlagUpdate) {
    const lock = await this.lockCurrent(folder);
    try {
      for (const [key, flag] of [['seen', '\\Seen'], ['starred', '\\Flagged']] as const) {
        if (update[key] === undefined) continue;
        const accepted = update[key] ? await this.client.messageFlagsAdd(uid, [flag], { uid: true })
          : await this.client.messageFlagsRemove(uid, [flag], { uid: true });
        if (!accepted) throw new Error('服务器未接受邮件标记变更');
      }
    } finally { lock.release(); }
  }
  async move(folder: Folder, uid: number, destination: string) {
    const lock = await this.lockCurrent(folder);
    try {
      const result = await this.client.messageMove(uid, destination, { uid: true });
      if (!result) throw new Error('服务器未接受邮件移动');
      return { uid: result.uidMap?.get(uid), uidValidity: result.uidValidity?.toString() };
    }
    finally { lock.release(); }
  }
  async send(input: SendInput, sentPath?: string) {
    if (this.account.sentCopy === 'append' && !sentPath) throw new Error('请先在邮箱中创建已发送文件夹，并同步后再发送');
    const message = new MailComposer({
      from: { name: this.account.name, address: this.account.email }, to: input.to, cc: input.cc,
      subject: input.subject, text: input.text, html: input.html,
      inReplyTo: input.inReplyTo, references: input.references, disableFileAccess: true, disableUrlAccess: true,
    }).compile();
    const raw = await message.build();
    const transport = this.smtp();
    try {
      const result = await transport.sendMail({
        envelope: { from: this.account.email, to: [...input.to, ...input.cc, ...input.bcc] }, raw,
      });
      const warnings: string[] = [];
      if (result.rejected.length) warnings.push(`部分收件人被服务器拒绝：${result.rejected.join('、')}。请勿向已接受的收件人重复发送。`);
      if (this.account.sentCopy === 'append') {
        try { await this.client.append(sentPath!, raw, ['\\Seen']); }
        catch { warnings.push('邮件已发送，但保存已发送副本失败。请勿重复发送。'); }
      }
      return { messageId: result.messageId, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
    } finally { transport.close(); }
  }
  async watchInbox(onChange: () => void, onError: (error: Error) => void) {
    const client = this.newClient(true);
    let stopped = false;
    client.on('error', onError);
    client.on('close', () => { if (!stopped) onError(new Error('收件箱监听连接已断开，将在轮询时重新连接')); });
    client.on('exists', onChange);
    client.on('flags', onChange);
    client.on('expunge', onChange);
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      void client.idle().catch(error => { if (!stopped) onError(error); });
    } catch (error) { stopped = true; client.close(); throw error; }
    return () => { stopped = true; client.close(); };
  }
  private async lockCurrent(folder: Folder) {
    const lock = await this.client.getMailboxLock(folder.path);
    if (!this.client.mailbox || this.client.mailbox.uidValidity.toString() !== folder.uidValidity) {
      lock.release();
      throw new Error('文件夹已在服务器重建，请同步后重试');
    }
    return lock;
  }
  private newClient(watch = false) {
    const server = this.account.imap;
    const client = new ImapFlow({
      host: server.host, port: server.port, secure: server.security === 'tls',
      ...(server.security !== 'tls' ? { doSTARTTLS: server.security === 'starttls' } : {}),
      auth: { user: server.user, pass: server.password }, proxy: this.account.proxy,
      clientInfo: { name: 'Mail', version: '0.1.0', vendor: 'Mail' },
      logger: false, disableAutoIdle: !watch, maxIdleTime: 25 * 60_000, connectionTimeout: 20_000, greetingTimeout: 20_000,
      // The worker must stay alive between 60-second polling cycles.
      socketTimeout: watch ? undefined : 90_000,
    });
    client.on('error', () => { /* Command promises report errors; the next operation reconnects. */ });
    return client;
  }
  private smtp() {
    const server = this.account.smtp;
    const options: SMTPTransport.Options & { proxy?: string; disableFileAccess: boolean; disableUrlAccess: boolean } = {
      host: server.host, port: server.port, secure: server.security === 'tls',
      requireTLS: server.security === 'starttls', ignoreTLS: server.security === 'plain',
      auth: { user: server.user, pass: server.password }, proxy: this.account.proxy,
      connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
      disableFileAccess: true, disableUrlAccess: true,
    };
    const transport = nodemailer.createTransport(options);
    transport.set('proxy_socks_module', socks);
    return transport;
  }
}

function folderRole(path: string, specialUse?: string): FolderRole {
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  const roles: Record<string, FolderRole> = { '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk', '\\Archive': 'archive', '\\All': 'archive' };
  if (specialUse && roles[specialUse]) return roles[specialUse];
  const names: Record<string, FolderRole> = { sent: 'sent', 'sent items': 'sent', 'sent messages': 'sent', drafts: 'drafts', trash: 'trash', deleted: 'trash', 'deleted items': 'trash', junk: 'junk', spam: 'junk', archive: 'archive', '已发送': 'sent', '已删除': 'trash', '草稿箱': 'drafts' };
  return names[path.toLowerCase()] ?? 'other';
}

async function metadata(message: FetchMessageObject): Promise<MailMetadata> {
  const envelope = message.envelope;
  const headers = message.headers ? await PostalMime.parse(message.headers) : undefined;
  const refs = `${headers?.references ?? ''} ${headers?.inReplyTo ?? envelope?.inReplyTo ?? ''}`.match(/<[^>]+>/g) ?? [];
  const address = (items?: { name?: string; address?: string }[]): Address[] => (items ?? []).map(item => ({ name: item.name ?? '', address: item.address ?? '' }));
  return {
    uid: message.uid, remoteId: message.emailId ?? null, providerThreadId: message.threadId ?? null,
    messageId: envelope?.messageId ?? '', references: [...new Set(refs)], subject: envelope?.subject ?? '',
    from: address(envelope?.from), to: address(envelope?.to), replyTo: address(envelope?.replyTo),
    date: new Date(envelope?.date ?? message.internalDate ?? 0).getTime() || 0,
    flags: [...(message.flags ?? [])],
  };
}
