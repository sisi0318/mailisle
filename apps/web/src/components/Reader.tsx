import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, Download, ImageOff, Mail, MailOpen, Reply, Star, Trash2 } from 'lucide-react';
import type { Folder, FolderRole, Message, MessageBody } from '@mail/shared';
import { api, json } from '../api';
import { fileSize, folderList, fullDate, listDate, senderName } from '../format';
import { mailDocument } from '../mail-html';
import { Button } from './ui';

type Props = {
  message: Message;
  folders: Folder[];
  onReply: () => void;
  onBack: () => void;
  onSelect: (message: Message) => void;
  onFlag: (patch: { seen?: boolean; starred?: boolean }) => void;
  /** Called once the message has left the folder being viewed. */
  onMoved: () => void;
};

export function Reader({ message, folders, onReply, onBack, onSelect, onFlag, onMoved }: Props) {
  const query = useQueryClient();
  const body = useQuery({ queryKey: ['body', message.id], queryFn: () => api<MessageBody>(`/messages/${message.id}/body`), retry: false });
  const thread = useQuery({ queryKey: ['thread', message.id], queryFn: () => api<Message[]>(`/messages/${message.id}/thread`) });
  const move = useMutation({ mutationFn: (folderId: string) => api(`/messages/${message.id}/move`, json('POST', { folderId })),
    onSuccess: () => { onMoved(); void query.invalidateQueries({ queryKey: ['messages'] }); } });
  const rendered = useMemo(() => body.data?.html ? mailDocument(body.data.html) : null, [body.data?.html]);
  const targets = folderList(folders.filter(folder => folder.accountId === message.accountId));
  const byRole = (role: FolderRole) => targets.find(({ folder }) => folder.role === role)?.folder;
  const archive = byRole('archive');
  const trash = byRole('trash');
  const recipients = message.to.map(to => to.name || to.address).join('、');
  const attachments = body.data?.attachments ?? [];

  return <section className="reader">
    <div className="reader-toolbar">
      <Button variant="ghost" className="reader-back" onClick={onBack} aria-label="返回列表"><ArrowLeft size={18} /></Button>
      <Button variant="ghost" onClick={onReply}><Reply size={17} />回复</Button>
      <span className="toolbar-separator" />
      <Button variant="ghost" aria-label={message.seen ? '标为未读' : '标为已读'} title={message.seen ? '标为未读' : '标为已读'} onClick={() => onFlag({ seen: !message.seen })}>{message.seen ? <Mail size={17} /> : <MailOpen size={17} />}</Button>
      <Button variant="ghost" aria-label={message.starred ? '取消星标' : '加星标'} title={message.starred ? '取消星标' : '加星标'} aria-pressed={message.starred} className={message.starred ? 'starred' : ''} onClick={() => onFlag({ starred: !message.starred })}><Star size={17} fill={message.starred ? 'currentColor' : 'none'} /></Button>
      <Button variant="ghost" aria-label="归档" title={archive ? '归档' : '这个邮箱没有归档文件夹'} disabled={move.isPending || !archive} onClick={() => move.mutate(archive!.id)}><Archive size={17} /></Button>
      <Button variant="ghost" aria-label="移到已删除" title={trash ? '移到已删除' : '这个邮箱没有已删除文件夹'} disabled={move.isPending || !trash} onClick={() => move.mutate(trash!.id)}><Trash2 size={17} /></Button>
      <select aria-label="移动到文件夹" value="" disabled={move.isPending} onChange={event => { if (event.target.value) move.mutate(event.target.value); }}>
        <option value="">{move.isPending ? '正在移动…' : '移动到…'}</option>
        {targets.map(({ folder, label }) => <option key={folder.id} value={folder.id}>{label}</option>)}
      </select>
    </div>

    <header className="reader-head">
      <h1>{message.subject || '（无主题）'}</h1>
      <div className="sender">
        <span className="avatar" aria-hidden>{senderName(message).slice(0, 1).toUpperCase()}</span>
        <div className="sender-text">
          <p><strong>{senderName(message)}</strong>{message.from[0]?.name && <span>{message.from[0].address}</span>}</p>
          <p title={message.to.map(to => to.address).join(', ')}>发给 {recipients || '（未列出收件人）'}</p>
        </div>
        <time>{fullDate(message.date)}</time>
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
          <Download size={15} /><span>{attachment.filename}</span><small>{fileSize(attachment.size)}</small>
        </a>)}
      </div>}
      {rendered && rendered.blockedImages > 0 && <p className="reader-note"><ImageOff size={14} />已屏蔽 {rendered.blockedImages} 张图片，发件人不会知道你读了这封信。</p>}
    </header>

    <div className="reader-body">
      {body.isPending ? <p className="loading">正在读取邮件…</p>
        : body.error ? <div className="list-state"><p className="error">{body.error.message}</p><Button onClick={() => { void body.refetch(); }}>重新加载</Button></div>
        : rendered ? <iframe title="邮件正文" className="mail-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={rendered.document} />
        : <pre className="plain-body">{body.data.text || '（邮件没有正文）'}</pre>}
    </div>
  </section>;
}

export function ReaderEmpty() {
  return <section className="reader-empty">
    <Mail size={40} strokeWidth={1.1} />
    <p>选择一封邮件开始阅读</p>
  </section>;
}
