import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, Ellipsis, MailOpen, Star, Trash2, X } from 'lucide-react';
import type { ComposeMode, Folder, Message, MessageAction, MessagePage } from '@mail/shared';
import { listDate, senderName } from '../format';
import { MessageMenu, moveToRole, type MessageMenuPosition } from './MessageMenu';
import { Button } from './ui';

type Props = {
  messages: UseInfiniteQueryResult<InfiniteData<MessagePage>, Error>;
  rows: Message[];
  selectedId?: string;
  sourceFolderId?: string;
  folders: Folder[];
  receiving: (message: Message) => boolean;
  canReply: boolean;
  busy: boolean;
  onSelect: (message: Message) => void;
  onStar: (message: Message) => void;
  onReply: (message: Message, mode: ComposeMode, includeAttachments?: boolean) => void;
  onRaw: (message: Message) => void;
  onAction: (messages: Message[], action: MessageAction) => Promise<string[]>;
  accountMark?: (accountId: string) => { name: string; color: string } | undefined;
  empty: ReactNode;
};

export function MessageList({ messages, rows, selectedId, sourceFolderId, folders, receiving, canReply, busy, onSelect, onStar, onReply, onRaw, onAction, accountMark, empty }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const lastChecked = useRef<string>(undefined);
  const longPress = useRef<{ timer: number; pointerId: number; x: number; y: number }>(undefined);
  const suppressClick = useRef<string>(undefined);
  const [checked, setChecked] = useState(new Set<string>());
  const [menu, setMenu] = useState<{ id?: string; position: MessageMenuPosition }>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const cancelLongPress = useCallback(() => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = undefined;
  }, []);
  useEffect(() => cancelLongPress, [cancelLongPress]);
  // Rows are two lines, or three once a preview is cached, so heights are measured rather than fixed.
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: index => rows[index]?.preview ? 90 : 66,
    getItemKey: index => rows[index].id, overscan: 8 });
  const visible = virtual.getVirtualItems();
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = messages;
  const lastIndex = visible[visible.length - 1]?.index ?? -1;
  useEffect(() => {
    if (lastIndex >= rows.length - 8 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const selected = rows.filter(message => checked.has(message.id));
  const allChecked = rows.length > 0 && selected.length === rows.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !allChecked;
  }, [allChecked, selected.length]);
  const rowUnderMenu = menu?.id ? rows.find(row => row.id === menu.id) : undefined;
  const menuRows = rowUnderMenu && !checked.has(rowUnderMenu.id) ? [rowUnderMenu] : selected;

  function setSelection(message: Message, value: boolean, range: boolean) {
    const from = range ? rows.findIndex(row => row.id === lastChecked.current) : -1;
    const to = rows.indexOf(message);
    const targets = from < 0 ? [message] : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
    lastChecked.current = message.id;
    setChecked(current => {
      const next = new Set(current);
      for (const target of targets) if (value) next.add(target.id); else next.delete(target.id);
      return next;
    });
  }

  function startLongPress(event: PointerEvent<HTMLButtonElement>, message: Message) {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = undefined;
    cancelLongPress();
    if (busy || event.ctrlKey || event.metaKey) return;
    const { pointerId, clientX: x, clientY: y } = event;
    longPress.current = { pointerId, x, y, timer: window.setTimeout(() => {
      longPress.current = undefined;
      suppressClick.current = message.id;
      setSelection(message, !checked.has(message.id), false);
    }, 500) };
  }

  function trackLongPress(event: PointerEvent<HTMLButtonElement>) {
    const press = longPress.current;
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancelLongPress();
  }

  async function run(targets: Message[], action: MessageAction) {
    const succeeded = await onAction(targets, action);
    setChecked(current => {
      const next = new Set(current);
      for (const id of succeeded) next.delete(id);
      return next;
    });
  }

  /** Arrow keys walk the rows without opening or marking an email. */
  function walk(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const current = Number((event.target as HTMLElement).closest<HTMLElement>('[data-index]')?.dataset.index ?? -1);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    if (next === current) return;
    virtual.scrollToIndex(next);
    requestAnimationFrame(() => requestAnimationFrame(() => scroll.current?.querySelector<HTMLElement>('[data-index="' + next + '"] [data-message-id]')?.focus()));
  }

  if (messages.isPending) return <div className="list-state">正在读取本地邮件…</div>;
  if (messages.isError && !messages.data) return <div className="list-state"><p className="error">{messages.error.message}</p><Button onClick={() => { void messages.refetch(); }}>重试</Button></div>;
  if (!rows.length) return <div className="list-state">{empty}</div>;

  const mutable = !busy && selected.length > 0 && selected.every(receiving);
  return <>
    {selected.length > 0 && <div className="message-selection" aria-label="邮件选择">
      <label className="message-checkbox select-loaded" title="只选择已经加载的邮件">
        <input ref={selectAll} type="checkbox" aria-label="选择已加载的邮件" disabled={busy} checked={allChecked}
          onChange={() => { setChecked(allChecked ? new Set() : new Set(rows.map(message => message.id))); lastChecked.current = undefined; }} />
      </label>
        <span className="selection-count" role="status">{busy ? '正在处理…' : '已选 ' + selected.length + ' 封'}</span>
        <div className="selection-actions">
          <Button variant="ghost" aria-label="批量标为已读" title="标为已读" disabled={!mutable}
            onClick={() => { void run(selected, { type: 'flags', patch: { seen: true } }); }}><MailOpen size={16} aria-hidden /></Button>
          <Button variant="ghost" aria-label="批量归档" title="归档" disabled={!mutable} onClick={() => { void run(selected, moveToRole('archive')); }}><Archive size={16} aria-hidden /></Button>
          <Button variant="ghost" aria-label="批量移到已删除" title="移到已删除" disabled={!mutable} onClick={() => { void run(selected, moveToRole('trash')); }}><Trash2 size={16} aria-hidden /></Button>
          <Button variant="ghost" aria-label="更多批量操作" aria-haspopup="menu" title="更多操作" disabled={busy}
            onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ position: { x: rect.left, y: rect.bottom, trigger: event.currentTarget } });
            }}><Ellipsis size={17} aria-hidden /></Button>
          <Button variant="ghost" aria-label="清除所选邮件" title="清除选择" disabled={busy} onClick={() => { setChecked(new Set()); lastChecked.current = undefined; }}><X size={16} aria-hidden /></Button>
        </div>
    </div>}
    <div className="message-scroll" ref={scroll} onKeyDown={walk}>
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {visible.map(item => {
          const message = rows[item.index];
          const mark = accountMark?.(message.accountId);
          const subject = message.subject || '（无主题）';
          return <div key={item.key} ref={virtual.measureElement} data-index={item.index}
            className={'message-row ' + (message.seen ? '' : 'unread ') + (selectedId === message.id ? 'selected ' : '') + (checked.has(message.id) ? 'checked' : '')}
            style={{ transform: 'translateY(' + item.start + 'px)' }}
            onContextMenu={event => {
              event.preventDefault();
              if (busy || ((event.nativeEvent as MouseEvent & { pointerType?: string }).pointerType === 'touch'
                && (longPress.current || suppressClick.current === message.id))) return;
              cancelLongPress();
              const trigger = event.currentTarget.querySelector<HTMLButtonElement>('[data-message-id]')!;
              setMenu({ id: message.id, position: { x: event.clientX, y: event.clientY, trigger } });
            }}>
            {selected.length > 0 && <label className="message-checkbox row-checkbox">
              <input type="checkbox" aria-label={'选择邮件：' + subject} disabled={busy} checked={checked.has(message.id)}
                onChange={event => setSelection(message, event.currentTarget.checked, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} />
            </label>}
            <button type="button" data-message-id={message.id} className="row-open" aria-current={selectedId === message.id} aria-keyshortcuts="Control+Space"
              onPointerDown={event => startLongPress(event, message)} onPointerMove={trackLongPress}
              onPointerUp={cancelLongPress} onPointerLeave={cancelLongPress} onPointerCancel={cancelLongPress}
              onClick={event => {
                if (suppressClick.current === message.id) { suppressClick.current = undefined; return; }
                if (event.ctrlKey || event.metaKey) {
                  if (!busy) setSelection(message, !checked.has(message.id), event.shiftKey);
                  return;
                }
                onSelect(message);
              }}
              onKeyDown={event => {
                if (!busy && (event.ctrlKey || event.metaKey) && event.code === 'Space') {
                  event.preventDefault();
                  if (!event.repeat) setSelection(message, !checked.has(message.id), event.shiftKey);
                  return;
                }
                if (busy || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ id: message.id, position: { x: rect.left + 8, y: rect.bottom, trigger: event.currentTarget } });
              }}>
              {!message.seen && <span className="unread-dot"><span className="sr-only">未读</span></span>}
              <span className="row-top">
                <span className="row-sender">{senderName(message)}</span>
                {mark && <span className="account-mark" style={{ background: mark.color }} title={mark.name}><span className="sr-only">{mark.name}</span></span>}
                <time>{listDate(message.date)}</time>
              </span>
              <span className="row-subject">{subject}</span>
              {message.preview && <span className="row-preview">{message.preview}</span>}
            </button>
            <div className="row-actions">
              <Button variant="ghost" className="row-star star-toggle" disabled={busy || !receiving(message)}
                aria-label={message.starred ? '取消星标' : '加星标'} aria-pressed={message.starred} title={message.starred ? '取消星标' : '加星标'}
                onClick={() => onStar(message)}><Star size={16} aria-hidden fill={message.starred ? 'currentColor' : 'none'} /></Button>
              <Button variant="ghost" className="row-more" aria-label="更多邮件操作" aria-haspopup="menu" title="更多操作" disabled={busy}
                onClick={event => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ id: message.id, position: { x: rect.left, y: rect.bottom, trigger: event.currentTarget } });
                }}><Ellipsis size={16} aria-hidden /></Button>
            </div>
          </div>;
        })}
      </div>
      {isFetchingNextPage && <p className="loading">正在加载更多…</p>}
      {isFetchNextPageError && <div className="list-state"><Button onClick={() => { void fetchNextPage(); }}>重试加载更多</Button></div>}
    </div>
    {menu && menuRows.length > 0 && (rowUnderMenu || !menu.id) && <MessageMenu key={menu.id ?? 'selection'} position={menu.position} messages={menuRows}
      sourceFolderId={sourceFolderId} folders={folders} receiving={receiving} canReply={canReply} onOpen={onSelect} onReply={onReply} onRaw={onRaw}
      onAction={(targets, action) => { void run(targets, action); }} onClose={closeMenu} />}
  </>;
}
