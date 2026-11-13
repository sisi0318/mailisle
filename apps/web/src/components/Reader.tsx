import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, Download, FolderInput, Forward, Image, ImageOff, Mail, MailOpen, Reply, ReplyAll, Star, Trash2 } from 'lucide-react';
import { RAW_PREVIEW_BYTES, type Address, type ComposeMode, type Folder, type FolderRole, type Message, type MessageBody, type RawMessage } from '@mail/shared';
import { api, json } from '../api';
import { fileSize, folderList, fullDate, listDate, senderName } from '../format';
import { mailDocument } from '../mail-html';
import { Button, CopyButton, FileName, Modal, Toolbar } from './ui';

type Props = {
  message: Message;
  folders: Folder[];
  /** Set when several mailboxes are connected, to say which one this message is in. */
  accountName?: string;
  /** The reader covers the list instead of sitting next to it. */
  covering: boolean;
  backLabel?: string;
  onReply: (mode: ComposeMode, includeAttachments?: boolean) => void;
  composing: boolean;
  receiving: boolean;
  onBack: () => void;
  onSelect: (message: Message) => void;
  onFlag: (patch: { seen?: boolean; starred?: boolean }) => void;
  onMoved: () => void;
};

const people = (list: Address[]) => list.map(item => item.name ? `${item.name} <${item.address}>` : item.address).join('、');

export function Reader({ message, folders, accountName, covering, backLabel, onReply, composing, receiving, onBack, onSelect, onFlag, onMoved }: Props) {
  const query = useQueryClient();
  const back = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Asked for per message: this component is created anew for each one, so the choice does not carry over.
  const [showImages, setShowImages] = useState(false);
  const [showingRaw, setShowingRaw] = useState(false);
  const body = useQuery({ queryKey: ['body', message.id], queryFn: () => api<MessageBody>(`/messages/${message.id}/body`), retry: false });
  const thread = useQuery({ queryKey: ['thread', message.id], queryFn: () => api<Message[]>(`/messages/${message.id}/thread`) });
  const move = useMutation({ mutationFn: (folderId: string) => api(`/messages/${message.id}/move`, json('POST', { folderId })),
    onSuccess: () => { onMoved(); for (const key of ['messages', 'counts', 'thread']) void query.invalidateQueries({ queryKey: [key] }); } });
  const rendered = useMemo(() => body.data?.html ? mailDocument(body.data.html, body.data.inlineImages, { remoteImages: showImages }) : null, [body.data?.html, body.data?.inlineImages, showImages]);
  // The list underneath cannot be reached while the reader covers it, so keyboard focus moves along.
  useEffect(() => { if (covering) back.current?.focus(); }, [covering]);
  const targets = receiving ? folderList(folders.filter(folder => folder.accountId === message.accountId)) : [];
  const byRole = (role: FolderRole) => targets.find(({ folder }) => folder.role === role)?.folder;
  const archive = byRole('archive');
  const trash = byRole('trash');
  const sender = message.from[0];
  const copied = (body.data?.cc ?? []).filter(item => item.address);
  // Replies would go somewhere other than the visible sender; worth showing, since that is a common phishing trick.
  const replyTo = message.replyTo.filter(item => item.address && item.address.toLowerCase() !== sender?.address.toLowerCase());
  const embedded = new Set(rendered?.embeddedAttachmentIds ?? []);
  const attachments = (body.data?.attachments ?? []).filter(attachment => !embedded.has(attachment.id));

  return <section className="reader" aria-label="邮件阅读">
    <Toolbar className="reader-toolbar" aria-label="邮件操作">
      <Button ref={back} variant="ghost" className="reader-back" onClick={onBack} aria-label={backLabel ? `返回${backLabel}` : '返回列表'} title="返回列表（Esc）"><ArrowLeft size={18} aria-hidden /></Button>
      <Button variant="ghost" disabled={composing} onClick={() => onReply('reply')}><Reply size={17} aria-hidden />回复</Button>
      <Button variant="ghost" disabled={composing} aria-label="全部回复" title="全部回复" onClick={() => onReply('reply-all')}><ReplyAll size={17} aria-hidden /></Button>
      <Button variant="ghost" disabled={composing} aria-label="转发，带上附件" title="转发并携带附件（含内嵌图片文件）" onClick={() => onReply('forward')}><Forward size={17} aria-hidden /></Button>
      <Button variant="ghost" disabled={composing} className="forward-text" onClick={() => onReply('forward', false)}>仅转发正文</Button>
      <span className="toolbar-separator" role="separator" aria-orientation="vertical" />
      <Button variant="ghost" disabled={!receiving} aria-label={message.seen ? '标为未读' : '标为已读'} title={!receiving ? '此邮箱已关闭收信' : message.seen ? '标为未读' : '标为已读'} onClick={() => onFlag({ seen: !message.seen })}>{message.seen ? <Mail size={17} aria-hidden /> : <MailOpen size={17} aria-hidden />}</Button>
      <Button variant="ghost" disabled={!receiving} aria-label="星标" title={!receiving ? '此邮箱已关闭收信' : message.starred ? '取消星标' : '加星标'} aria-pressed={message.starred} className={message.starred ? 'starred' : ''} onClick={() => onFlag({ starred: !message.starred })}><Star size={17} aria-hidden fill={message.starred ? 'currentColor' : 'none'} /></Button>
      <Button variant="ghost" aria-label="归档" title={archive ? '归档' : '这个邮箱没有归档文件夹'} disabled={move.isPending || !archive} onClick={() => move.mutate(archive!.id)}><Archive size={17} aria-hidden /></Button>
      <Button variant="ghost" aria-label="移到已删除" title={trash ? '移到已删除' : '这个邮箱没有已删除文件夹'} disabled={move.isPending || !trash} onClick={() => move.mutate(trash!.id)}><Trash2 size={17} aria-hidden /></Button>
      <MoveMenu targets={targets} pending={move.isPending} onMove={folderId => move.mutate(folderId)} />
    </Toolbar>

    <header className="reader-head">
      <h1>{message.subject || '（无主题）'}</h1>
      <div className="sender">
        <span className="avatar" aria-hidden>{senderName(message).slice(0, 1).toUpperCase()}</span>
        <div className={`sender-text ${expanded ? 'expanded' : ''}`}>
          {/* The address is never cut off: a long display name must not be able to push it out of view. */}
          <p className="sender-from"><strong>{senderName(message)}</strong>{sender?.name && <span>&lt;{sender.address}&gt;</span>}</p>
          <p>发给 {(expanded ? people(message.to) : message.to.map(to => to.name || to.address).join('、')) || '（未列出收件人）'}</p>
          {copied.length > 0 && <p>抄送 {expanded ? people(copied) : copied.map(item => item.name || item.address).join('、')}</p>}
          {replyTo.length > 0 && <p>回复将发往 {people(replyTo)}</p>}
          <p className="sender-meta"><time dateTime={message.date ? new Date(message.date).toISOString() : undefined}>{fullDate(message.date)}</time>{accountName && <span className="account-badge">{accountName}</span>}
            <button type="button" className="link-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '完整地址'}</button>
            <button type="button" className="link-button" onClick={() => setShowingRaw(true)}>原始邮件</button></p>
        </div>
      </div>
      {move.error && <p role="alert" className="error">{move.error.message}</p>}
      {(thread.data?.length ?? 0) > 1 && <details className="thread">
        <summary>同一会话 · {thread.data!.length} 封</summary>
        {thread.data!.map(item => <button key={item.id} className={item.id === message.id ? 'active' : ''} onClick={() => onSelect(item)}>
          <span>{senderName(item)}</span><time>{listDate(item.date)}</time>
        </button>)}
      </details>}
      {attachments.length > 0 && <div className="attachments" aria-label={`附件 ${attachments.length} 个`}>
        {attachments.map(attachment => <a key={attachment.id} href={`/api/messages/${message.id}/attachments/${attachment.id}`} download={attachment.filename} title={`下载 ${attachment.filename}`}>
          <Download size={15} aria-hidden /><FileName name={attachment.filename} /><small>{fileSize(attachment.size)}</small>
        </a>)}
      </div>}
      {rendered && (rendered.blockedImages > 0 || showImages) && <p className="reader-note">
        {showImages ? <><Image size={14} aria-hidden />正在显示这封信里的网络图片，发件人可能会知道你打开了它。</>
          : <><ImageOff size={14} aria-hidden />已屏蔽 {rendered.blockedImages} 张图片，发件人不会知道你读了这封信。</>}
        {rendered.remoteImages > 0 && <button type="button" className="link-button" onClick={() => setShowImages(!showImages)}>{showImages ? '重新屏蔽' : '显示图片'}</button>}
      </p>}
    </header>

    <div className="reader-body">
      {body.isPending ? <p className="loading">正在读取邮件…</p>
        : body.error ? <div className="list-state"><p className="error">{body.error.message}</p><Button onClick={() => { void body.refetch(); }}>重新加载</Button></div>
        : rendered ? <iframe title="邮件正文" className="mail-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={rendered.document} />
        : <pre className="plain-body">{body.data.text || '（邮件没有正文）'}</pre>}
    </div>
    {showingRaw && <RawMessageModal messageId={message.id} subject={message.subject} onClose={() => setShowingRaw(false)} />}
  </section>;
}

function RawMessageModal({ messageId, subject, onClose }: { messageId: string; subject: string; onClose: () => void }) {
  const codeId = useId();
  const raw = useQuery({ queryKey: ['raw', messageId], queryFn: () => api<RawMessage>(`/messages/${messageId}/raw`), retry: false });

  return <Modal title="原始邮件" description={subject || '（无主题）'} wide className="raw-mail-modal" onClose={onClose}>
    {raw.isPending ? <p className="loading">正在读取原始邮件…</p>
      : raw.error ? <div className="list-state"><p className="error">{raw.error.message}</p><Button onClick={() => { void raw.refetch(); }}>重新加载</Button></div>
      : <>
        <div className="raw-mail-bar">
          <p className="raw-mail-meta">
            <span>大小 {fileSize(raw.data.size)}</span>
            {raw.data.truncated && <span> · 仅预览前 {fileSize(RAW_PREVIEW_BYTES)}，完整内容请下载 .eml</span>}
          </p>
          <div className="raw-mail-actions">
            <CopyButton targetId={codeId}>{raw.data.truncated ? '复制预览' : '复制源码'}</CopyButton>
            <a className="button button-secondary" href={`/api/messages/${messageId}/raw?download=1`} download><Download size={16} aria-hidden />下载 .eml</a>
          </div>
        </div>
        <pre className="raw-mail-source"><code id={codeId}>{raw.data.content}</code></pre>
      </>}
  </Modal>;
}

/** A menu instead of a select: arrow keys in a closed select change its value, which moved mail by accident. */
function MoveMenu({ targets, pending, onMove }: { targets: { folder: Folder; label: string }[]; pending: boolean; onMove: (folderId: string) => void }) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [fallbackStyle, setFallbackStyle] = useState<CSSProperties>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const onToggle = (event: Event) => {
      const next = (event as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) {
        setFallbackStyle(undefined);
        return;
      }
      if (!CSS.supports('position-area: block-end') && triggerRef.current) {
        const anchor = triggerRef.current.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        const pad = 8;
        const left = Math.max(pad, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - pad));
        const spaceBelow = window.innerHeight - anchor.bottom - pad;
        const top = spaceBelow >= rect.height || spaceBelow >= anchor.top - pad
          ? Math.min(anchor.bottom + 4, window.innerHeight - rect.height - pad)
          : Math.max(pad, anchor.top - rect.height - 4);
        setFallbackStyle({ left, top });
      }
      el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    };
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, []);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      menuRef.current?.hidePopover?.();
      triggerRef.current?.focus();
      return;
    }
    if ('focusGroup' in HTMLElement.prototype) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
  }

  return <div className="move-menu">
    <Button ref={triggerRef} variant="ghost" className="move-trigger" popoverTarget={menuId} popoverTargetAction="toggle"
      aria-haspopup="menu" aria-expanded={open} disabled={pending || !targets.length}>
      <FolderInput size={17} aria-hidden />{pending ? '正在移动…' : '移动到'}
    </Button>
    <div id={menuId} ref={menuRef} popover="auto" role="menu" focusgroup="menu nomemory" aria-label="移动到文件夹"
      className="move-menu-list" style={fallbackStyle} onKeyDown={keys}>
      <div className="move-menu-items">
        {targets.map(({ folder, label }) => <button key={folder.id} type="button" role="menuitem"
          onClick={() => { menuRef.current?.hidePopover?.(); onMove(folder.id); }}>{label}</button>)}
      </div>
    </div>
  </div>;
}

export function ReaderEmpty() {
  return <section className="reader-empty">
    <Mail size={40} strokeWidth={1.1} aria-hidden />
    <p>选择一封邮件开始阅读</p>
  </section>;
}
