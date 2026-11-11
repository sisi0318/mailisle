import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Inbox, Mail, Menu, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { Account, ComposeMode, Draft, DraftSummary, Folder, Message, MessagePage, SyncEvent, UnreadCounts } from '@mail/shared';
import { api, json } from './api';
import { accountColor, folderList } from './format';
import { Button } from './components/ui';
import { Login } from './components/Login';
import { MessageList } from './components/MessageList';
import { Reader, ReaderEmpty } from './components/Reader';
import { Sidebar, type Filter } from './components/Sidebar';
import { DraftList } from './components/DraftList';
import * as Dialog from '@radix-ui/react-dialog';

type FlagPatch = { seen?: boolean; starred?: boolean };
const Composer = lazy(() => import('./components/Composer').then(module => ({ default: module.Composer })));
const AccountForm = lazy(() => import('./components/AccountForm').then(module => ({ default: module.AccountForm })));
const OAuthSettings = lazy(() => import('./components/OAuth').then(module => ({ default: module.OAuthSettings })));

export default function App() {
  const query = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ authenticated: boolean }>('/session'), retry: false });
  useEffect(() => {
    const expire = () => { query.clear(); query.setQueryData(['session'], { authenticated: false }); };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [query]);
  if (session.isPending) return <div className="full-state"><Mail /><p>正在打开…</p></div>;
  if (session.error) return <div className="full-state"><p>{session.error.message}</p><Button onClick={() => { void session.refetch(); }}>重试</Button></div>;
  if (!session.data.authenticated) return <Login onLogin={() => { void query.invalidateQueries({ queryKey: ['session'] }); }} />;
  return <Mailbox />;
}

function Mailbox() {
  const query = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/folders') });
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api<UnreadCounts>('/counts') });
  const [filter, setFilter] = useState<Filter>({ view: 'inbox' });
  const [search, setSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selected, setSelected] = useState<Message | null>(null);
  const [accountForm, setAccountForm] = useState<{ id?: string } | null>(null);
  const [composer, setComposer] = useState<{ draft?: Draft; accountId?: string } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [oauthSettings, setOAuthSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  // A flag change only returns once the mail server has taken it, which can be seconds. It is shown at
  // once from here and dropped when fresh list data has arrived, so a refetch in between cannot undo it.
  const [pendingFlags, setPendingFlags] = useState<Record<string, FlagPatch>>({});

  const messages = useInfiniteQuery({
    queryKey: ['messages', filter, searchTerm], initialPageParam: 0,
    queryFn: ({ pageParam }) => api<MessagePage>(`/messages?${new URLSearchParams({ ...filter, view: filter.view === 'drafts' ? 'all' : filter.view, q: searchTerm, offset: String(pageParam) })}`),
    getNextPageParam: page => page.nextOffset ?? undefined,
    enabled: filter.view !== 'drafts',
  });
  const drafts = useQuery({ queryKey: ['drafts', filter.accountId], queryFn: () => api<DraftSummary[]>(`/drafts${filter.accountId ? `?accountId=${filter.accountId}` : ''}`), enabled: filter.view === 'drafts' });
  const prepare = useMutation({ mutationFn: ({ messageId, mode, includeAttachments }: { messageId: string; mode: ComposeMode; includeAttachments: boolean }) => api<Draft>(`/messages/${messageId}/draft`, json('POST', { mode, includeAttachments, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })),
    onSuccess: draft => { setComposer({ draft }); void query.invalidateQueries({ queryKey: ['drafts'] }); void query.invalidateQueries({ queryKey: ['counts'] }); }, onError: error => setNotice(error.message) });
  const withPending = useCallback((message: Message) => pendingFlags[message.id] ? { ...message, ...pendingFlags[message.id] } : message, [pendingFlags]);
  const rows = useMemo(() => (messages.data?.pages.flatMap(page => page.messages) ?? []).map(withPending), [messages.data, withPending]);
  const selectedMessage = selected && (rows.find(message => message.id === selected.id) ?? withPending(selected));
  const accountList = useMemo(() => accounts.data ?? [], [accounts.data]);
  const folderRows = useMemo(() => folderList(folders.data ?? []), [folders.data]);

  useEffect(() => {
    const timer = setTimeout(() => { setSearchTerm(search.trim()); setSelected(null); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const refresh = (keys = ['accounts', 'folders', 'messages', 'thread', 'counts', 'drafts']) => {
      keys.forEach(key => pending.add(key));
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; for (const key of pending) void query.invalidateQueries({ queryKey: [key] }); pending.clear(); }, 400);
    };
    events.addEventListener('ready', () => { setConnected(true); setSyncing(new Set()); refresh(); });
    events.addEventListener('update', event => {
      const update = JSON.parse((event as MessageEvent<string>).data) as SyncEvent;
      if (update.messageId) void query.invalidateQueries({ queryKey: ['body', update.messageId] });
      if (update.state) setSyncing(current => {
        const next = new Set(current);
        if (update.state === 'running') next.add(update.accountId); else next.delete(update.accountId);
        return next;
      });
      refresh(update.type === 'draft' ? ['drafts', 'counts'] : update.contentOnly ? ['messages', 'thread'] : update.type === 'sync' ? ['accounts'] : undefined);
    });
    events.onerror = () => { setConnected(false); void query.invalidateQueries({ queryKey: ['session'] }); };
    return () => { clearTimeout(timer); events.close(); };
  }, [query]);

  const flag = useCallback(async (message: Message, patch: FlagPatch) => {
    setPendingFlags(current => ({ ...current, [message.id]: { ...current[message.id], ...patch } }));
    try { await api(`/messages/${message.id}/flags`, json('PATCH', patch)); }
    catch (error) { setNotice((error as Error).message); }
    await Promise.all([query.invalidateQueries({ queryKey: ['messages'] }), query.invalidateQueries({ queryKey: ['thread'] }), query.invalidateQueries({ queryKey: ['counts'] })]);
    setPendingFlags(current => {
      const rest = { ...current[message.id] };
      // A newer change to the same flag is still on its way; leave that one in place.
      for (const key of Object.keys(patch) as (keyof FlagPatch)[]) if (rest[key] === patch[key]) delete rest[key];
      const { [message.id]: _settled, ...others } = current;
      return Object.keys(rest).length ? { ...others, [message.id]: rest } : others;
    });
  }, [query]);

  function navigate(next: Filter) { setFilter(next); setSelected(null); setMobileNav(false); }
  function select(message: Message) {
    setSelected(message);
    if (!message.seen) void flag(message, { seen: true });
  }
  async function removeAccount(account: Account) {
    if (!window.confirm(`移除“${account.name}”及它在本机的邮件索引和草稿？服务器上的邮件不受影响。`)) return;
    try { await api(`/accounts/${account.id}`, { method: 'DELETE' }); navigate({ view: 'inbox' }); await query.invalidateQueries(); }
    catch (error) { setNotice((error as Error).message); }
  }
  function syncAll() {
    for (const account of accountList) void api(`/accounts/${account.id}/sync`, { method: 'POST' }).catch((error: Error) => setNotice(error.message));
  }
  async function openDraft(id: string) {
    try { setComposer({ draft: await api<Draft>(`/drafts/${id}`) }); }
    catch (error) { setNotice((error as Error).message); }
  }
  async function deleteDraft(id: string) {
    if (!window.confirm('删除这封本地草稿和不再使用的附件？')) return;
    try { await api(`/drafts/${id}`, { method: 'DELETE' }); await query.invalidateQueries({ queryKey: ['drafts'] }); await query.invalidateQueries({ queryKey: ['counts'] }); }
    catch (error) { setNotice((error as Error).message); }
  }
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)');
    const resize = () => { if (!media.matches) setMobileNav(false); };
    media.addEventListener('change', resize); return () => media.removeEventListener('change', resize);
  }, []);
  async function logout() {
    await api('/logout', { method: 'POST' }).catch(() => undefined);
    query.clear();
    query.setQueryData(['session'], { authenticated: false });
  }

  const account = accountList.find(item => item.id === filter.accountId);
  const folder = folderRows.find(item => item.folder.id === filter.folderId);
  const isDrafts = filter.view === 'drafts';
  const title = isDrafts ? '本地草稿' : searchTerm ? '搜索结果' : folder ? folder.label : account ? '收件箱' : filter.view === 'starred' ? '星标邮件' : filter.view === 'all' ? '所有邮件' : '统一收件箱';
  const total = isDrafts ? drafts.data?.length : messages.data?.pages[0]?.total;
  const scope = [!isDrafts && searchTerm && `“${searchTerm}”`, account ? account.name : accountList.length > 1 && '全部邮箱', total !== undefined && `${total} 封`].filter(Boolean).join(' · ');
  const accountMark = !account && accountList.length > 1 ? (accountId: string) => {
    const index = accountList.findIndex(item => item.id === accountId);
    return index < 0 ? undefined : { name: accountList[index].name, color: accountColor(index) };
  } : undefined;
  const empty = searchTerm ? <><Search size={30} strokeWidth={1.3} /><h3>没有找到相关邮件</h3><p>换个关键词试试。后台会逐步补全正文索引。</p></>
    : accountList.length ? <><Inbox size={30} strokeWidth={1.3} /><h3>这里没有邮件</h3><p>同步完成后，来信会出现在这里。</p></>
    : <><Inbox size={30} strokeWidth={1.3} /><h3>先连接一个邮箱</h3><p>连接后，邮件会同步到这台设备。</p><Button variant="primary" onClick={() => setAccountForm({})}><Plus size={15} />连接邮箱</Button></>;
  const sidebarProps = { accounts: accountList, folders: folders.data ?? [], filter, syncing, connected, counts: counts.data,
    onNavigate: navigate, onClose: () => setMobileNav(false),
    onEditAccount: (item: Account) => { setMobileNav(false); setAccountForm({ id: item.id }); },
    onCompose: () => { setMobileNav(false); setComposer({ accountId: filter.accountId }); },
    onAddAccount: () => { setMobileNav(false); setAccountForm({}); },
    onOAuthSettings: () => { setMobileNav(false); setOAuthSettings(true); },
    onRemoveAccount: (item: Account) => { void removeAccount(item); }, onLogout: () => { void logout(); } };

  return <div className="mail-app">
    <Sidebar {...sidebarProps} mobileOpen={false} />
    <Dialog.Root open={mobileNav} onOpenChange={setMobileNav}><Dialog.Portal>
      <Dialog.Overlay className="sidebar-backdrop" />
      <Dialog.Content className="mobile-sidebar-dialog" aria-describedby={undefined}><Dialog.Title className="sr-only">邮箱导航</Dialog.Title><Sidebar {...sidebarProps} mobileOpen /></Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    <main className="workspace">
      <header className="workspace-header">
        <Button className="mobile-menu" variant="ghost" aria-label="打开邮箱导航" aria-expanded={mobileNav} aria-controls="mobile-mail-sidebar" onClick={() => setMobileNav(true)}><Menu size={20} /></Button>
        <div className="header-title"><h1>{title}</h1>{scope && <span>{scope}</span>}</div>
        <div className="header-actions">
          {!isDrafts && <div className="search-box">
            <Search size={16} />
            <input aria-label="搜索邮件" placeholder={account ? `在“${account.name}”中搜索` : '搜索全部邮箱'} value={search} onChange={event => setSearch(event.target.value)} />
            {search && <button aria-label="清空搜索" onClick={() => setSearch('')}><X size={15} /></button>}
          </div>}
          <Button variant="ghost" aria-label="同步全部邮箱" title="同步全部邮箱" disabled={!accountList.length || syncing.size > 0} onClick={syncAll}><RefreshCw size={17} className={syncing.size ? 'spin' : ''} /></Button>
        </div>
      </header>
      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {(accounts.error || folders.error) && <p className="error">{accounts.error?.message || folders.error?.message}</p>}
      <div className="mail-panes">
        <section className="message-pane">
          {isDrafts ? drafts.isPending ? <p className="loading">正在读取草稿…</p> : drafts.error ? <p className="error">{drafts.error.message}</p>
            : <DraftList drafts={drafts.data ?? []} accounts={accountList} onOpen={id => { void openDraft(id); }} onDelete={id => { void deleteDraft(id); }} />
            : <MessageList key={JSON.stringify([filter, searchTerm])} messages={messages} rows={rows} selectedId={selected?.id} onSelect={select} accountMark={accountMark} empty={empty} />}
        </section>
        {isDrafts ? <section className="reader-empty"><FileText size={40} strokeWidth={1.1} /><p>选择一封草稿继续编辑</p><small>草稿保存在本机服务，不会同步到邮箱服务商。</small></section> : selectedMessage
          ? <Reader key={selectedMessage.id} message={selectedMessage} folders={folders.data ?? []} composing={prepare.isPending} onReply={(mode, includeAttachments = true) => prepare.mutate({ messageId: selectedMessage.id, mode, includeAttachments })}
              onBack={() => setSelected(null)} onSelect={select} onFlag={patch => { void flag(selectedMessage, patch); }} onMoved={() => setSelected(null)} />
          : <ReaderEmpty />}
      </div>
    </main>
    {accountForm && <Suspense fallback={null}><AccountForm accountId={accountForm.id} onClose={() => setAccountForm(null)} onSaved={id => navigate({ view: 'inbox', accountId: id })} /></Suspense>}
    {oauthSettings && <Suspense fallback={null}><OAuthSettings onClose={() => setOAuthSettings(false)} /></Suspense>}
    {composer && <Suspense fallback={null}><Composer key={composer.draft?.id ?? 'new'} accounts={accountList} draft={composer.draft} accountId={composer.accountId} onClose={() => setComposer(null)} onSent={setNotice} /></Suspense>}
  </div>;
}
