import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ListFilter, Tags } from 'lucide-react';
import { MAX_MESSAGE_TAG_FILTERS, type Account, type MessageTag } from '@mail/shared';
import { api } from '../api';
import { Button } from './ui';

export type MailFilters = { read?: 'read' | 'unread'; starred?: '1'; tags?: string[] };

const readOptions = [{ label: '全部', value: undefined }, { label: '已读', value: 'read' }, { label: '未读', value: 'unread' }] as const;
const starOptions = [{ label: '全部', value: undefined }, { label: '星标', value: '1' }] as const;

type Props = {
  filters: MailFilters;
  onChange: (filters: MailFilters) => void;
  starView: boolean;
  accounts: Account[];
  accountId?: string;
};

export function QuickFilters({ filters, onChange, starView, accounts, accountId }: Props) {
  const id = useId();
  const tagsId = useId();
  const [open, setOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const tags = useQuery({
    queryKey: ['message-tags', accountId],
    queryFn: () => api<MessageTag[]>(accountId ? '/message-tags?accountId=' + encodeURIComponent(accountId) : '/message-tags'),
    enabled: open && tagsOpen,
  });
  const selected = new Set(filters.tags);
  const hasFilters = !!(filters.read || filters.starred || selected.size);
  const groups = accounts.map(account => ({ account, tags: tags.data?.filter(tag => tag.accountId === account.id) ?? [] }))
    .filter(group => group.tags.length > 0);

  function toggleTag(id: string, checked: boolean) {
    if (checked) selected.add(id); else selected.delete(id);
    onChange({ ...filters, tags: selected.size ? [...selected].sort() : undefined });
  }

  return <div className="quick-filters">
    <Button variant="ghost" className="quick-filter-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ListFilter size={16} aria-hidden />快捷筛选{hasFilters && <span className="filter-dot" aria-label="已启用" />}
    </Button>
    <div id={id} hidden={!open} className="quick-filter-options" aria-label="邮件筛选">
      <div className="filter-segments" role="group" aria-label="阅读状态">
        {readOptions.map(({ label, value }) => <Button key={label} variant="ghost" aria-pressed={filters.read === value}
          onClick={() => onChange({ ...filters, read: value })}>{label}</Button>)}
      </div>
      {!starView && <div className="filter-segments" role="group" aria-label="星标状态">
        {starOptions.map(({ label, value }) => <Button key={label} variant="ghost" aria-label={value ? '仅星标' : '不限星标'}
          aria-pressed={filters.starred === value} onClick={() => onChange({ ...filters, starred: value })}>{label}</Button>)}
      </div>}
      <Button variant="ghost" className="tag-filter-trigger" aria-expanded={tagsOpen} aria-controls={tagsId}
        onClick={() => setTagsOpen(!tagsOpen)}><Tags size={14} aria-hidden />标签{selected.size > 0 && <span>{selected.size}</span>}<ChevronDown size={12} aria-hidden /></Button>
      {hasFilters && <button type="button" className="link-button" onClick={() => onChange({})}>清除</button>}
      <div id={tagsId} hidden={!tagsOpen} className="tag-filter-options">
        {tags.isPending ? <p role="status">正在读取标签…</p> : tags.isError ? <>
          <p role="alert">{tags.error.message}</p><Button variant="ghost" onClick={() => { void tags.refetch(); }}>重试</Button>
        </> : groups.length === 0 ? <p>没有已同步的标签</p> : groups.map(({ account, tags }) => <fieldset key={account.id}>
          <legend>{account.name}</legend>
          {tags.map(tag => {
            const key = tag.accountId + ':' + tag.keyword;
            const checked = selected.has(key);
            return <label key={key} className="message-checkbox">
              <input type="checkbox" checked={checked} disabled={!checked && selected.size >= MAX_MESSAGE_TAG_FILTERS}
                onChange={event => toggleTag(key, event.target.checked)} />
              <span title={tag.label}>{tag.label}</span>
            </label>;
          })}
        </fieldset>)}
        {selected.size >= MAX_MESSAGE_TAG_FILTERS && <p role="status">最多选择 {MAX_MESSAGE_TAG_FILTERS} 个标签</p>}
      </div>
    </div>
  </div>;
}
