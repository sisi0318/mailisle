import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, Download, Mail, MailOpen, Reply, Star, Trash2 } from 'lucide-react';
import type { Folder, Message, MessageBody } from '@mail/shared';
import { api, json } from '../api';
import { mailDocument } from '../mail-html';
import { Button } from './ui';

export function Reader({ message, folders, onReply, onBack, onSelect }: { message: Message; folders: Folder[]; onReply: () => void; onBack: () => void; onSelect: (message: Message) => void }) {
  const query = useQueryClient();
  const body = useQuery({ queryKey: ['body', message.id], queryFn: () => api<MessageBody>(`/messages/${message.id}/body`), retry: false });
  const thread = useQuery({ queryKey: ['thread', message.id], queryFn: () => api<Message[]>(`/messages/${message.id}/thread`) });
  const action = useMutation({ mutationFn: ({ path, method, data }: { path: string; method: string; data: unknown }) => api(`/messages/${message.id}/${path}`, json(method, data)),
    onSuccess: () => { void query.invalidateQueries({ queryKey: ['messages'] }); void query.invalidateQueries({ queryKey: ['thread'] }); } });
  const html = useMemo(() => body.data?.html ? mailDocument(body.data.html) : null, [body.data?.html]);
  const targetFolders = folders.filter(folder => folder.accountId === message.accountId);
  const move = (folderId: string) => action.mutate({ path: 'move', method: 'POST', data: { folderId } });
  const flag = (data: { seen?: boolean; starred?: boolean }) => action.mutate({ path: 'flags', method: 'PATCH', data });
  return <section className="reader">
    <div className="reader-toolbar"><Button variant="ghost" className="reader-back" onClick={onBack} aria-label="返回列表"><ArrowLeft size={18} /></Button>
      <Button variant="ghost" onClick={onReply}><Reply size={17} />回复</Button><span className="toolbar-separator" />
      <Button variant="ghost" aria-label={message.seen ? '标为未读' : '标为已读'} title={message.seen ? '标为未读' : '标为已读'} disabled={action.isPending} onClick={() => flag({ seen: !message.seen })}>{message.seen ? <Mail size={17} /> : <MailOpen size={17} />}</Button>
      <Button variant="ghost" aria-label="星标" title="星标" disabled={action.isPending} onClick={() => flag({ starred: !message.starred })}><Star size={17} fill={message.starred ? 'currentColor' : 'none'} /></Button>
      <Button variant="ghost" aria-label="归档" title="归档" disabled={action.isPending || !targetFolders.some(folder => folder.role === 'archive')} onClick={() => move(targetFolders.find(folder => folder.role === 'archive')!.id)}><Archive size={17} /></Button>
      <Button variant="ghost" aria-label="移到垃圾箱" title="移到垃圾箱" disabled={action.isPending || !targetFolders.some(folder => folder.role === 'trash')} onClick={() => move(targetFolders.find(folder => folder.role === 'trash')!.id)}><Trash2 size={17} /></Button>
      <select aria-label="移动到文件夹" value="" disabled={action.isPending} onChange={event => { if (event.target.value) move(event.target.value); }}><option value="">移动到…</option>{targetFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
    </div>
    <div className="reader-content"><div className="reader-kicker">邮件详情<span>{message.cached ? '已缓存到本机' : '按需加载正文'}</span></div><h1>{message.subject || '（无主题）'}</h1>
      <div className="sender"><span className="avatar">{(message.from[0]?.name || message.from[0]?.address || '?').slice(0, 1).toUpperCase()}</span><div><strong>{message.from.map(from => from.name || from.address).join('、')}</strong><span>{message.from.map(from => from.address).join(', ')}</span><span>收件人：{message.to.map(to => to.address).join(', ')}</span></div><time>{new Date(message.date).toLocaleString('zh-CN')}</time></div>
      {action.error && <p role="alert" className="error">{action.error.message}</p>}
      {body.isPending ? <p className="loading">正在读取邮件…</p> : body.error ? <div className="error"><p>{body.error.message}</p><Button onClick={() => { void body.refetch(); }}>重新加载</Button></div> : <>
        <div className="privacy-note">远程图片已屏蔽，保护你的阅读隐私。</div>
        {html ? <iframe title="邮件正文" className="mail-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html} /> : <pre className="plain-body">{body.data.text || '（邮件没有正文）'}</pre>}
        {body.data.attachments.length > 0 && <div className="attachments"><h3>附件 · {body.data.attachments.length}</h3>{body.data.attachments.map(attachment => <a key={attachment.id} href={`/api/messages/${message.id}/attachments/${attachment.id}`} download={attachment.filename}><Download size={17} /><span>{attachment.filename}<small>{(attachment.size / 1024).toFixed(1)} KB</small></span></a>)}</div>}
      </>}
      {(thread.data?.length ?? 0) > 1 && <div className="thread"><h3>同一会话 · {thread.data!.length}</h3>{thread.data!.map(item => <button key={item.id} className={item.id === message.id ? 'active' : ''} onClick={() => onSelect(item)}>{item.subject || '（无主题）'}<span>{new Date(item.date).toLocaleDateString('zh-CN')}</span></button>)}</div>}
    </div>
  </section>;
}
