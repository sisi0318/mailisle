import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Star } from 'lucide-react';
import type { Message, MessagePage } from '@mail/shared';
import { listDate, senderName } from '../format';
import { Button } from './ui';

type Props = {
  messages: UseInfiniteQueryResult<InfiniteData<MessagePage>, Error>;
  rows: Message[];
  selectedId?: string;
  onSelect: (message: Message) => void;
  /** Set when the list mixes accounts; returns the mark that tells them apart. */
  accountMark?: (accountId: string) => { name: string; color: string } | undefined;
  empty: ReactNode;
};

export function MessageList({ messages, rows, selectedId, onSelect, accountMark, empty }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  // Rows are two lines, or three once a preview is cached, so heights are measured rather than fixed.
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: index => rows[index]?.preview ? 90 : 66,
    getItemKey: index => rows[index].id, overscan: 8 });
  const visible = virtual.getVirtualItems();
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = messages;
  const lastIndex = visible[visible.length - 1]?.index ?? -1;
  useEffect(() => {
    if (lastIndex >= rows.length - 8 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  if (messages.isPending) return <div className="list-state">正在读取本地邮件…</div>;
  if (messages.error) return <div className="list-state"><p className="error">{messages.error.message}</p><Button onClick={() => { void messages.refetch(); }}>重试</Button></div>;
  if (!rows.length) return <div className="list-state">{empty}</div>;

  /** Arrow keys walk the rows; Enter opens one. Moving alone does not open mail, so it does not mark anything read. */
  function walk(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const current = Number((event.target as HTMLElement).closest<HTMLElement>('[data-index]')?.dataset.index ?? -1);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    if (next === current) return;
    virtual.scrollToIndex(next);
    // The row may only be rendered once the list has scrolled.
    requestAnimationFrame(() => requestAnimationFrame(() => scroll.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()));
  }

  return <div className="message-scroll" ref={scroll} onKeyDown={walk}>
    <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
      {visible.map(item => {
        const message = rows[item.index];
        const mark = accountMark?.(message.accountId);
        return <button key={item.key} ref={virtual.measureElement} data-index={item.index} data-message-id={message.id} onClick={() => onSelect(message)}
          className={`message-row ${message.seen ? '' : 'unread'} ${selectedId === message.id ? 'selected' : ''}`}
          aria-current={selectedId === message.id} style={{ transform: `translateY(${item.start}px)` }}>
          {!message.seen && <span className="unread-dot"><span className="sr-only">未读</span></span>}
          <div className="row-top">
            <span className="row-sender">{senderName(message)}</span>
            {message.starred && <Star className="row-star" size={13} fill="currentColor" aria-label="已加星标" />}
            {mark && <span className="account-mark" style={{ background: mark.color }} title={mark.name}><span className="sr-only">{mark.name}</span></span>}
            <time>{listDate(message.date)}</time>
          </div>
          <div className="row-subject">{message.subject || '（无主题）'}</div>
          {message.preview && <p className="row-preview">{message.preview}</p>}
        </button>;
      })}
    </div>
    {isFetchingNextPage && <p className="loading">正在加载更多…</p>}
    {isFetchNextPageError && <div className="list-state"><Button onClick={() => { void fetchNextPage(); }}>重试加载更多</Button></div>}
  </div>;
}
