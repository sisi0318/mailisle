import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, ArrowDown, ChevronRight, Circle, Folder as FolderIcon, Inbox, LogOut, Mail, Plus, RefreshCw, Search, ShieldCheck, SquarePen, Star, X } from 'lucide-react';
import type { Account, Folder, Message, MessagePage, SyncEvent } from '@mail/shared';
import { api, json } from './api';
import { Button } from './components/ui';
import { Login } from './components/Login';
import { Reader } from './components/Reader';

type Filter = { view: 'inbox' | 'all' | 'starred'; accountId?: string; folderId?: string };
const Composer = lazy(() => import('./components/Composer').then(module => ({ default: module.Composer })));
const AccountForm = lazy(() => import('./components/AccountForm').then(module => ({ default: module.AccountForm })));

export default function App() {
  const query = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ authenticated: boolean }>('/session'), retry: false });
  useEffect(() => {
    const expire = () => { query.clear(); query.setQueryData(['session'], { authenticated: false }); };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [query]);
  if (session.isPending) return <div className="full-state"><Mail /><p>正在打开你的邮件空间…</p></div>;
  if (session.error) return <div className="full-state"><p>{session.error.message}</p><Button onClick={() => { void session.refetch(); }}>重试</Button></div>;
  if (!session.data.authenticated) return <Login onLogin={() => { void query.invalidateQueries({ queryKey: ['session'] }); }} />;
  return <Mailbox />;
}

function Mailbox() {
  const query = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/folders') });
  const [filter, setFilter] = useState<Filter>({ view: 'inbox' });
  const [search, setSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selected, setSelected] = useState<Message | null>(null);
  const [adding, setAdding] = useState(false);
  const [composer, setComposer] = useState<{ reply?: Message } | null>(null);
  const [notice, setNotice] = useState('');
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const messages = useInfiniteQuery({
    queryKey: ['messages', filter, searchTerm], initialPageParam: 0,
    queryFn: ({ pageParam }) => api<MessagePage>(`/messages?${new URLSearchParams({ ...filter, q: searchTerm, offset: String(pageParam) })}`),
    getNextPageParam: page => page.nextOffset ?? undefined,
  });
  const rows = messages.data?.pages.flatMap(page => page.messages) ?? [];
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 112, overscan: 6 });
  const visible = virtual.getVirtualItems();
  const selectedMessage = rows.find(message => message.id === selected?.id) ?? selected;
  const mutation = useMutation({ mutationFn: ({ path, method }: { path: string; method: string }) => api(path, { method }),
    onSuccess: () => { void query.invalidateQueries(); }, onError: error => setNotice(error.message) });

  useEffect(() => {
    const timer = setTimeout(() => { setSearchTerm(search); setSelected(null); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const last = visible[visible.length - 1];
    if (last && last.index >= rows.length - 8 && messages.hasNextPage && !messages.isFetchingNextPage && !messages.isFetchNextPageError) void messages.fetchNextPage();
  }, [visible, rows.length, messages.hasNextPage, messages.isFetchingNextPage, messages.isFetchNextPageError, messages.fetchNextPage]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('ready', () => {
      setConnected(true); setSyncing(new Set());
      void query.invalidateQueries({ queryKey: ['accounts'] });
      void query.invalidateQueries({ queryKey: ['folders'] });
      void query.invalidateQueries({ queryKey: ['messages'] });
    });
    events.addEventListener('update', event => {
      const update = JSON.parse(event.data) as SyncEvent;
      setSyncing(current => { const next = new Set(current); if (update.state === 'running') next.add(update.accountId); else if (update.state) next.delete(update.accountId); return next; });
      void query.invalidateQueries({ queryKey: ['accounts'] });
      void query.invalidateQueries({ queryKey: ['folders'] });
      void query.invalidateQueries({ queryKey: ['messages'] });
      void query.invalidateQueries({ queryKey: ['thread'] });
    });
    events.onerror = () => { setConnected(false); void query.invalidateQueries({ queryKey: ['session'] }); };
    return () => events.close();
  }, [query]);
  function navigate(next: Filter) { setFilter(next); setSelected(null); scroll.current?.scrollTo(0, 0); }
  function select(message: Message) {
    setSelected(message);
    if (!message.seen) void api(`/messages/${message.id}/flags`, json('PATCH', { seen: true })).then(() => query.invalidateQueries({ queryKey: ['messages'] })).catch(error => setNotice(error.message));
  }
  const title = searchTerm ? '搜索结果' : filter.folderId ? folders.data?.find(folder => folder.id === filter.folderId)?.name ?? '文件夹' : filter.view === 'starred' ? '星标邮件' : filter.view === 'all' ? '所有邮件' : '统一收件箱';
  const accountList = accounts.data ?? [];
  return <div className={`mail-app ${selected ? 'has-selection' : ''}`}>
    <aside className="sidebar"><div className="brand"><Mail size={23} /><span>mail<span className="brand-dot">.</span></span><span className="local-badge">本机</span></div>
      <Button variant="primary" className="compose-button" disabled={!accountList.length} onClick={() => setComposer({})}><SquarePen size={18} />写邮件<Plus size={16} /></Button>
      <nav className="main-nav">{([{ view: 'inbox', label: '统一收件箱', Icon: Inbox }, { view: 'starred', label: '星标邮件', Icon: Star }, { view: 'all', label: '所有邮件', Icon: Archive }] as const).map(({ view, label, Icon }) => <button key={view} aria-label={label} className={filter.view === view && !filter.accountId && !filter.folderId ? 'active' : ''} onClick={() => navigate({ view })}><Icon size={18} /><span>{label}</span>{view === 'inbox' && <ChevronRight size={14} />}</button>)}</nav>
      <div className="sidebar-label">我的邮箱<button aria-label="添加邮箱" onClick={() => setAdding(true)}><Plus size={16} /></button></div>
      <div className="account-list">{accountList.map((account, i) => <div className="account-group" key={account.id}>
        <button className={`account-button ${filter.accountId === account.id && !filter.folderId ? 'active' : ''}`} onClick={() => navigate({ view: 'inbox', accountId: account.id })}><Circle size={10} fill={['#558c78', '#b19b6e', '#788aab'][i % 3]} stroke="none" /><span>{account.name}<small>{account.email}</small></span>{syncing.has(account.id) && <RefreshCw className="spin" size={13} />}</button>
        {account.error && <p className="account-error">{account.error}</p>}
        {filter.accountId === account.id && <div className="folder-list">{folders.data?.filter(folder => folder.accountId === account.id).map(folder => <button key={folder.id} className={filter.folderId === folder.id ? 'active' : ''} onClick={() => navigate({ view: 'all', accountId: account.id, folderId: folder.id })}><FolderIcon size={13} />{folder.name}</button>)}
          <button className="remove-account" onClick={() => { if (window.confirm(`移除“${account.name}”及本地邮件索引？服务器上的邮件将保留。`)) { mutation.mutate({ path: `/accounts/${account.id}`, method: 'DELETE' }); navigate({ view: 'inbox' }); } }}>移除账号</button></div>}
      </div>)}<button className="add-account" onClick={() => setAdding(true)}><Plus size={15} />连接一个邮箱</button></div>
      <div className="sidebar-bottom"><div><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{syncing.size ? '正在同步邮件' : connected ? '已连接本机服务' : '正在重新连接'}</span></div><div><ShieldCheck size={14} /><span>凭据加密 · 本地存储</span></div><button onClick={() => { void api('/logout', { method: 'POST' }).then(() => { query.clear(); query.setQueryData(['session'], { authenticated: false }); }); }}><LogOut size={14} />退出登录</button></div>
    </aside>
    <main className="workspace"><header className="workspace-header"><div><span className="eyebrow">YOUR PERSONAL MAILSPACE</span><h1>{title}</h1></div><div className="header-actions"><div className="search-box"><Search size={17} /><input aria-label="搜索邮件" placeholder="搜索所有邮箱…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div><Button variant="ghost" aria-label="同步邮箱" title="同步全部邮箱" disabled={!accountList.length || syncing.size > 0} onClick={() => accountList.forEach(account => mutation.mutate({ path: `/accounts/${account.id}/sync`, method: 'POST' }))}><RefreshCw size={18} className={syncing.size ? 'spin' : ''} /></Button></div></header>
      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {(accounts.error || folders.error) && <p className="error">{accounts.error?.message || folders.error?.message}</p>}
      <div className="mail-panes"><section className="message-pane"><div className="list-heading"><span>{searchTerm ? `“${searchTerm}”` : filter.accountId ? accountList.find(account => account.id === filter.accountId)?.name : '全部账号'}<small>{messages.data?.pages[0]?.total ?? 0} 封邮件</small></span><span>最新优先<ArrowDown size={12} /></span></div>
        <div className="message-scroll" ref={scroll}>
          {messages.isPending ? <div className="list-state">正在读取本地邮件…</div> : messages.error ? <div className="list-state error">{messages.error.message}<Button onClick={() => { void messages.refetch(); }}>重试</Button></div> : !rows.length ? <div className="list-state"><Inbox size={32} strokeWidth={1.2} /><h3>{searchTerm ? '没有找到相关邮件' : accountList.length ? '这里暂时没有邮件' : '从连接邮箱开始'}</h3><p>{searchTerm ? '试试其他关键词。正文会在阅读后加入搜索。' : accountList.length ? '同步完成后，来信会出现在这里。' : '将工作与生活的来信，收进同一个空间。'}</p>{!accountList.length && <Button onClick={() => setAdding(true)}>连接邮箱<Plus size={15} /></Button>}</div> : <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>{visible.map(item => {
            const message = rows[item.index];
            return <button className={`message-row ${message.seen ? '' : 'unread'} ${selected?.id === message.id ? 'selected' : ''}`} key={message.id} onClick={() => select(message)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}><div className="message-top"><strong>{message.from[0]?.name || message.from[0]?.address || '未知发件人'}</strong><time>{new Date(message.date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</time></div><div className="message-subject">{!message.seen && <span className="unread-dot" />}{message.subject || '（无主题）'}{message.starred && <Star size={13} fill="currentColor" />}</div><p>{message.preview || '打开邮件，查看完整内容'}</p><small>{accountList.find(account => account.id === message.accountId)?.name}</small></button>;
          })}</div>}
          {messages.isFetchingNextPage && <p className="loading">正在加载更多…</p>}{messages.isFetchNextPageError && <Button onClick={() => { void messages.fetchNextPage(); }}>重试加载更多</Button>}
        </div>
      </section>
      {selectedMessage ? <Reader message={selectedMessage} folders={folders.data ?? []} onReply={() => setComposer({ reply: selectedMessage })} onBack={() => setSelected(null)} onSelect={select} /> : <section className="reader-empty"><div className="empty-illustration"><span /><span /><Mail size={38} strokeWidth={1.1} /></div><span className="eyebrow">ROOM TO FOCUS</span><h2>给每一封来信，留一点空间。</h2><p>从左侧选择邮件，开始阅读。</p><div><ShieldCheck size={15} />远程图片默认屏蔽</div></section>}
      </div>
    </main>
    {adding && <Suspense fallback={<div className="notice">正在打开账号设置…</div>}><AccountForm onClose={() => setAdding(false)} /></Suspense>}
    {composer && <Suspense fallback={<div className="notice">正在打开编辑器…</div>}><Composer accounts={accountList} reply={composer.reply} onClose={() => setComposer(null)} onSent={setNotice} /></Suspense>}
  </div>;
}
