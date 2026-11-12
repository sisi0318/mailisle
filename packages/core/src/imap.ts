import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import * as socks from 'socks';
import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';
import type { Address, FlagUpdate, Folder, FolderRole, MailMetadata, SendInput } from '@mail/shared';
import type { MailAdapter, SyncSink } from './adapter';
import type { OutgoingAttachment } from './uploads';
import type { AccountConfig } from './oauth';

export class ImapAdapter implements MailAdapter {
  private client: ImapFlow;
  private connecting?: Promise<void>;
  private connectionAttempted = false;
  private closed = false;
  constructor(private account: AccountConfig, readonly socketTimeoutMs = 90_000, private accessToken?: () => Promise<string>) {
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
    this.closed = false;
    this.connecting = (async () => {
      if (this.accessToken) {
        const token = await this.accessToken();
        if (this.closed) throw new Error('邮箱连接已关闭');
        this.client.close(); this.client = this.newClient(false, token);
      }
      await this.login(this.client);
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async verifySmtp() {
    const transport = await this.smtp();
    try { await transport.verify(); }
    catch (error) { throw this.smtpError(error); }
    finally { transport.close(); }
  }
  async close() { this.closed = true; this.client.close(); }
  async listFolders() {
    // IMAP flags are case-insensitive; QQ uses \\NoSelect for container folders.
    return (await this.client.list()).filter(folder => ![...folder.flags].some(flag => flag.toLowerCase() === '\\noselect')).map(folder => ({
      path: folder.path, name: folder.name, role: folderRole(folder.path, folder.specialUse), delimiter: folder.delimiter || null,
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
  async bodyText(folder: Folder, uid: number) {
    const lock = await this.lockCurrent(folder);
    try {
      const message = await this.client.fetchOne(uid, { bodyStructure: true }, { uid: true });
      if (!message || !message.bodyStructure) throw new Error('无法读取邮件正文结构');
      const parts = textParts(message.bodyStructure);
      const texts: string[] = [];
      for (const part of parts) {
        const content = part.part || 'TEXT';
        const fetched = await this.client.fetchOne(uid, { bodyParts: [content] }, { uid: true, binary: false });
        const bytes = fetched && fetched.bodyParts?.get(content.toLowerCase());
        if (!bytes) throw new Error('邮件正文未完整返回，稍后会重新预取');
        const parsed = await decodeTextPart(part, bytes);
        texts.push(parsed.text ?? convert(parsed.html ?? '', { wordwrap: false }));
      }
      return texts.join('\n');
    } finally { lock.release(); }
  }
  async copyRecipients(folder: Folder, uid: number) {
    const lock = await this.lockCurrent(folder);
    try {
      const message = await this.client.fetchOne(uid, { envelope: true }, { uid: true });
      if (!message) throw new Error('无法读取原邮件抄送信息，请同步后重试');
      return (message.envelope?.cc ?? []).map(address => ({ name: address.name ?? '', address: address.address ?? '' }));
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
  async markAllRead(folder: Folder) {
    const lock = await this.client.getMailboxLock(folder.path);
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) throw new Error('无法打开文件夹');
      const uidValidity = mailbox.uidValidity.toString();
      if (folder.uidValidity && folder.uidValidity !== uidValidity) throw new Error('文件夹已在服务器重建，请同步后重试');
      const uidNext = mailbox.uidNext;
      if (mailbox.exists && !await this.client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true })) throw new Error('服务器未接受全部已读操作');
      return { uidValidity, uidNext };
    } finally { lock.release(); }
  }
  async createFolder(name: string, parent?: Folder) {
    const folders = await this.client.list();
    const location = parent ? folders.find(folder => folder.path === parent.path) : folders.find(folder => folder.path.toUpperCase() === 'INBOX');
    if (parent && !location) throw new Error('上级文件夹已不存在，请同步后重试');
    const delimiter = location?.delimiter;
    if (parent && (!delimiter || [...(location?.flags ?? [])].some(flag => flag.toLowerCase() === '\\noinferiors'))) throw new Error('此文件夹不支持创建子文件夹');
    if (delimiter && name.includes(delimiter)) throw new Error(`文件夹名称不能包含层级分隔符“${delimiter}”`);
    const result = await this.client.mailboxCreate(parent ? [parent.path, name] : [name]);
    if (!result?.created) throw new Error('同名文件夹已存在');
    return result.path;
  }
  async deleteFolder(folder: Folder) {
    const listed = await this.client.list();
    const target = listed.find(item => item.path === folder.path);
    if (!target) throw new Error('文件夹已不存在，请刷新后重试');
    const descendants = listed.filter(item => item.path === target.path || (target.delimiter && item.path.startsWith(`${target.path}${target.delimiter}`)));
    if (descendants.some(item => folderRole(item.path, item.specialUse) !== 'other')) throw new Error('不能删除系统文件夹或包含系统文件夹的目录');
    for (const item of descendants.sort((a, b) => b.path.length - a.path.length)) {
      if (!await this.client.mailboxDelete(item.path)) throw new Error(`删除文件夹「${item.name}」未完成，请刷新后重试`);
    }
  }
  async send(input: SendInput, sentPath?: string, attachments: OutgoingAttachment[] = []) {
    const message = new MailComposer({
      from: { name: this.account.name, address: this.account.email }, to: input.to, cc: input.cc,
      subject: input.subject, text: input.text, html: input.html,
      inReplyTo: input.inReplyTo, references: input.references, disableFileAccess: true, disableUrlAccess: true,
      attachments: attachments.map(file => ({ filename: file.filename, content: file.content, contentType: file.mimeType })),
    }).compile();
    const raw = await message.build();
    const transport = await this.smtp();
    try {
      const result = await transport.sendMail({
        envelope: { from: this.account.email, to: [...input.to, ...input.cc, ...input.bcc] }, raw,
      });
      const warnings: string[] = [];
      if (result.rejected.length) warnings.push(`部分收件人被服务器拒绝：${result.rejected.join('、')}。请勿向已接受的收件人重复发送。`);
      if (this.account.receiveEnabled && this.account.sentCopy === 'append') {
        // A slow SMTP upload can outlast the idle timeout of the IMAP connection, so it is reopened when needed.
        try {
          if (!sentPath) throw new Error('没有可用的已发送文件夹');
          await this.connect(); await this.client.append(sentPath, raw, ['\\Seen']);
        }
        catch { warnings.push('邮件已发送，但保存已发送副本失败。请勿重复发送。'); }
      }
      return { messageId: result.messageId, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
    } catch (error) { throw this.smtpError(error); }
    finally { transport.close(); }
  }
  async watchInbox(onChange: () => void, onError: (error: Error) => void) {
    const token = this.accessToken ? await this.accessToken() : undefined;
    if (this.closed) throw new Error('邮箱连接已关闭');
    const client = this.newClient(true, token);
    let stopped = false;
    client.on('error', onError);
    client.on('close', () => { if (!stopped) onError(new Error('收件箱监听连接已断开，将在轮询时重新连接')); });
    client.on('exists', onChange);
    client.on('flags', onChange);
    client.on('expunge', onChange);
    try {
      await this.login(client);
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
  private newClient(watch = false, accessToken?: string) {
    const server = this.account.imap;
    const client = new ImapFlow({
      host: server.host, port: server.port, secure: server.security === 'tls',
      ...(server.security !== 'tls' ? { doSTARTTLS: server.security === 'starttls' } : {}),
      auth: accessToken ? { user: server.user, accessToken } : { user: server.user, pass: server.password }, proxy: this.account.proxy,
      clientInfo: { name: 'MailIsle', version: '0.1.0', vendor: 'MailIsle' },
      logger: false, disableAutoIdle: !watch, maxIdleTime: 25 * 60_000, connectionTimeout: 20_000, greetingTimeout: 20_000,
      // The worker must stay alive between 60-second polling cycles.
      socketTimeout: watch ? undefined : this.socketTimeoutMs,
    });
    client.on('error', () => { /* Command promises report errors; the next operation reconnects. */ });
    return client;
  }
  private async login(client: ImapFlow) {
    try { await client.connect(); }
    catch (error) {
      if (this.accessToken && (error as { authenticationFailed?: boolean }).authenticationFailed)
        throw new Error('邮箱 OAuth 登录未通过，请到邮箱设置重新授权，并确认 IMAP 已开启');
      throw error;
    }
  }
  private smtpError(error: unknown) {
    return this.accessToken && (error as { code?: string })?.code === 'EAUTH'
      ? new Error('邮箱 OAuth 发信登录未通过，请重新授权，并确认 SMTP AUTH 已开启及组织允许该权限') : error;
  }
  private async smtp() {
    const server = this.account.smtp;
    const options: SMTPTransport.Options & { proxy?: string; disableFileAccess: boolean; disableUrlAccess: boolean } = {
      host: server.host, port: server.port, secure: server.security === 'tls',
      requireTLS: server.security === 'starttls', ignoreTLS: server.security === 'plain',
      auth: this.accessToken ? { type: 'OAuth2', user: server.user, accessToken: await this.accessToken() } : { user: server.user, pass: server.password }, proxy: this.account.proxy,
      connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
      disableFileAccess: true, disableUrlAccess: true,
    };
    const transport = nodemailer.createTransport(options);
    transport.set('proxy_socks_module', socks);
    return transport;
  }
}

function textParts(node: MessageStructureObject): MessageStructureObject[] {
  if (node.disposition === 'attachment' || node.type === 'message/rfc822') return [];
  if (node.type === 'text/plain' || node.type === 'text/html') return [node];
  const children = (node.childNodes ?? []).map(textParts);
  if (node.type === 'multipart/alternative') {
    return children.find(parts => parts.some(part => part.type === 'text/plain')) ?? children.find(parts => parts.length > 0) ?? [];
  }
  return children.flat();
}

function decodeTextPart(part: MessageStructureObject, bytes: Buffer) {
  const encoding = (part.encoding ?? '7bit').toLowerCase();
  if (!['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding)) throw new Error('邮件正文使用了暂不支持的传输编码');
  const parameters = ['charset', 'format', 'delsp'].flatMap(name => part.parameters?.[name]
    ? [`${name}=${JSON.stringify(part.parameters[name])}`] : []);
  const headers = [`Content-Type: ${[part.type, ...parameters].join('; ')}`, `Content-Transfer-Encoding: ${encoding}`, '', ''].join('\r\n');
  return PostalMime.parse(Buffer.concat([Buffer.from(headers), bytes]));
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
    // Real threads never come close to this many references; a crafted header is cut to the most recent ones.
    messageId: envelope?.messageId ?? '', references: [...new Set(refs)].slice(-200), subject: envelope?.subject ?? '',
    from: address(envelope?.from), to: address(envelope?.to), replyTo: address(envelope?.replyTo),
    date: new Date(envelope?.date ?? message.internalDate ?? 0).getTime() || 0,
    flags: [...(message.flags ?? [])],
  };
}
