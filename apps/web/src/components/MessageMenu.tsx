import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Archive, ChevronLeft, ChevronRight, Download, FolderInput, Forward, Mail, MailOpen, Reply, ReplyAll, ShieldAlert, ShieldCheck, Star, Trash2 } from 'lucide-react';
import type { ComposeMode, Folder, Message, MessageAction, MessageMoveRole } from '@mail/shared';
import { folderList } from '../format';

export function moveToRole(role: MessageMoveRole): MessageAction {
  return { type: 'move', target: { role } };
}

export function isJunk(message: Message, folders: Folder[], sourceFolderId?: string) {
  const ids = sourceFolderId && message.folderIds?.includes(sourceFolderId) ? [sourceFolderId] : message.folderIds;
  return folders.some(folder => folder.role === 'junk' && ids?.includes(folder.id));
}

type Item = { label: string; icon?: ReactNode; disabled?: boolean; run: () => void };
export type MessageMenuPosition = { x: number; y: number; trigger: HTMLElement };

type Props = {
  position: MessageMenuPosition;
  messages: Message[];
  sourceFolderId?: string;
  folders: Folder[];
  receiving: (message: Message) => boolean;
  canReply: boolean;
  onOpen: (message: Message) => void;
  onReply: (message: Message, mode: ComposeMode, includeAttachments?: boolean) => void;
  onRaw: (message: Message) => void;
  onAction: (messages: Message[], action: MessageAction) => void;
  onClose: () => void;
};

type MenuPage = 'main' | 'reply' | 'forward' | 'mark' | 'move';
const icons = { read: <MailOpen aria-hidden />, unread: <Mail aria-hidden />, star: <Star aria-hidden />, archive: <Archive aria-hidden />,
  junk: <ShieldAlert aria-hidden />, restore: <ShieldCheck aria-hidden />, trash: <Trash2 aria-hidden /> };

export function MessageMenu({ position, messages, sourceFolderId, folders, receiving, canReply, onOpen, onReply, onRaw, onAction, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<MenuPage>('main');
  const single = messages.length === 1 ? messages[0] : undefined;
  const mutable = messages.every(receiving);
  const accountId = messages[0].accountId;
  const targets = mutable && messages.every(message => message.accountId === accountId)
    ? folderList(folders.filter(folder => folder.accountId === accountId && folder.id !== sourceFolderId
        && messages.some(message => !message.folderIds?.includes(folder.id) || !!sourceFolderId)))
    : [];
  const allRead = messages.every(message => message.seen);
  const allStarred = messages.every(message => message.starred);
  const allJunk = messages.every(message => isJunk(message, folders, sourceFolderId));
  const available = (role: MessageMoveRole) => mutable && folders.some(folder => folder.role === role
    && messages.some(message => message.accountId === folder.accountId && (sourceFolderId
      ? folder.id !== sourceFolderId : (role === 'inbox' && allJunk) || !message.folderIds?.includes(folder.id))));

  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    try { el.showPopover(); } catch { el.removeAttribute('popover'); }
    const close = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') onClose(); };
    const outside = (event: PointerEvent) => { if (!el.contains(event.target as Node)) onClose(); };
    el.addEventListener('toggle', close);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onClose);
    return () => {
      el.removeEventListener('toggle', close);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const padding = 8;
    el.style.left = Math.max(padding, Math.min(position.x, window.innerWidth - width - padding)) + 'px';
    el.style.top = Math.max(padding, Math.min(position.y, window.innerHeight - height - padding)) + 'px';
    el.scrollTop = 0;
    el.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [page, position]);

  function finish(run: () => void) {
    position.trigger.focus({ preventScroll: true });
    onClose();
    run();
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { onClose(); return; }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (event.key === 'Escape' || event.key === 'ArrowLeft' && page !== 'main') {
      event.preventDefault();
      event.stopPropagation();
      if (page !== 'main') setPage('main');
      else finish(() => {});
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined;
    if (next === undefined || !items.length) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  }

  const action = (label: string, command: MessageAction, icon: ReactNode, disabled = !mutable): Item =>
    ({ label, icon, disabled, run: () => finish(() => onAction(messages, command)) });
  const flags = (label: string, patch: Extract<MessageAction, { type: 'flags' }>['patch'], icon: ReactNode) =>
    action(label, { type: 'flags', patch }, icon);
  const role = (label: string, target: MessageMoveRole, icon: ReactNode) => action(label, moveToRole(target), icon, !available(target));
  const read = flags(allRead ? '标为未读' : '标为已读', { seen: !allRead }, allRead ? icons.unread : icons.read);
  const star = flags(allStarred ? '取消星标' : '加星标', { starred: !allStarred }, icons.star);
  const archive = role('归档', 'archive', icons.archive);
  const junk = allJunk ? role('移回收件箱', 'inbox', icons.restore) : role('标为垃圾邮件', 'junk', icons.junk);
  const trash = role('移到已删除', 'trash', icons.trash);
  const reply = (label: string, mode: ComposeMode, icon?: ReactNode, attachments?: boolean): Item =>
    ({ label, icon, disabled: !single || !canReply, run: () => finish(() => onReply(single!, mode, attachments)) });
  const item = ({ label, icon, disabled, run }: Item, iconOnly = false) => <button key={label} type="button" role="menuitem" tabIndex={-1}
    disabled={disabled} title={iconOnly ? label : undefined} aria-label={iconOnly ? label : undefined} onClick={run}>{icon}{!iconOnly && <span>{label}</span>}</button>;
  const branch = (label: string, next: MenuPage, icon: ReactNode, disabled = false) => <button type="button" role="menuitem" tabIndex={-1}
    disabled={disabled} aria-haspopup="menu" onClick={() => setPage(next)}
    onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setPage(next); } }}>{icon}<span>{label}</span><ChevronRight aria-hidden /></button>;

  return <div ref={menu} popover="manual" role="menu" aria-label={single ? '邮件操作' : '批量邮件操作'}
    className="message-context-menu" onKeyDown={keys}>
    {page === 'main' ? <>
      <div className="message-menu-quick" role="group" aria-label="快捷操作">{[read, star, archive, junk, trash].map(entry => item(entry, true))}</div>
      {single && <div className="message-menu-group" role="group" aria-label="阅读与回复">
        {item({ label: '打开邮件', icon: <MailOpen aria-hidden />, run: () => finish(() => onOpen(single)) })}
        {branch('回复', 'reply', <Reply aria-hidden />, !canReply)}
        {branch('转发', 'forward', <Forward aria-hidden />, !canReply)}
      </div>}
      <div className="message-menu-group" role="group" aria-label="整理邮件">
        {branch('标记', 'mark', <Star aria-hidden />, !mutable)}
        {branch('移动到', 'move', <FolderInput aria-hidden />, !targets.length)}
        {item(archive)}{item(junk)}{item(trash)}
      </div>
      {single && <div className="message-menu-group" role="group" aria-label="原始邮件">
        {item({ label: '查看原始邮件', icon: <Mail aria-hidden />, run: () => finish(() => onRaw(single)) })}
        <a role="menuitem" tabIndex={-1} href={'/api/messages/' + single.id + '/raw?download=1'} download
          onClick={() => window.setTimeout(() => finish(() => {}), 0)}><Download aria-hidden /><span>下载原始邮件</span></a>
      </div>}
    </> : <>
      {item({ label: '返回邮件操作', icon: <ChevronLeft aria-hidden />, run: () => setPage('main') })}
      <div className="message-menu-group" role="group" aria-label={page === 'move' ? '目标文件夹' : undefined}>
        {page === 'reply' && <>{item(reply('回复发件人', 'reply', <Reply aria-hidden />))}{item(reply('全部回复', 'reply-all', <ReplyAll aria-hidden />))}</>}
        {page === 'forward' && <>{item(reply('转发并携带附件', 'forward', <Forward aria-hidden />))}{item(reply('仅转发正文', 'forward', <Forward aria-hidden />, false))}</>}
        {page === 'mark' && <>{item(flags('标为已读', { seen: true }, icons.read))}{item(flags('标为未读', { seen: false }, icons.unread))}
          {item(flags('加星标', { starred: true }, icons.star))}{item(flags('取消星标', { starred: false }, icons.star))}</>}
        {page === 'move' && targets.map(({ folder, label }) => <button key={folder.id} type="button" role="menuitem" tabIndex={-1}
          onClick={() => finish(() => onAction(messages, { type: 'move', target: { folderId: folder.id } }))}><FolderInput aria-hidden /><span>{label}</span></button>)}
      </div>
    </>}
  </div>;
}
