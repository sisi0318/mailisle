import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { FileText, Inbox, Mail, Menu, Plus, RefreshCw, Search, Send, TriangleAlert, X } from 'lucide-react';
import type { Account, ComposeMode, Draft, DraftSummary, Folder, Message, MessagePage, SyncEvent, UnreadCounts, UpdateState } from '@mail/shared';
import { api, json } from './api';
import { accountColor, folderList } from './format';
import { Button, ConfirmModal, useMedia } from './components/ui';
import { Login, SessionLock } from './components/Login';
import { MessageList } from './components/MessageList';
import { Reader, ReaderEmpty } from './components/Reader';
import { Sidebar, type Filter } from './components/Sidebar';
import { DraftList } from './components/DraftList';
import type { MailActionTarget } from './components/MailActions';
import * as Dialog from '@radix-ui/react-dialog';

type FlagPatch = { seen?: boolean; starred?: boolean };
type Notice = { text: string; kind: 'success' | 'error' };
const Composer = lazy(() => import('./components/Composer').then(module => ({ default: module.Composer })));
const AccountForm = lazy(() => import('./components/AccountForm').then(module => ({ default: module.AccountForm })));
const AccountManager = lazy(() => import('./components/AccountManager').then(module => ({ default: module.AccountManager })));
const GlobalSettings = lazy(() => import('./components/GlobalSettings').then(module => ({ default: module.GlobalSettings })));
const VersionDialog = lazy(() => import('./components/VersionDialog').then(module => ({ default: module.VersionDialog })));
const MailActions = lazy(() => import('./components/MailActions').then(module => ({ default: module.MailActions })));
const CreateFolderDialog = lazy(() => import('./components/MailActions').then(module => ({ default: module.CreateFolderDialog })));
const DeleteFolderDialog = lazy(() => import('./components/MailActions').then(module => ({ default: module.DeleteFolderDialog })));
const pageTitle = document.title;

export default function App() {
  const query = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ authenticated: boolean }>('/session'), retry: false });
  const authenticated = session.data?.authenticated === true;
  // Whether the mailbox has been shown since the last deliberate logout. From then on it stays mounted:
  // when the session runs out, or the service is briefly unreachable, a message being written survives.
  const [opened, setOpened] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { if (authenticated) setOpened(true); }, [authenticated]);
  useEffect(() => {
    const expire = () => query.setQueryData(['session'], { authenticated: false });
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [query]);
  const login = () => { void query.invalidateQueries(); };
  const logout = useCallback(async () => {
    // Leaving on purpose is not an expired session: no lock, and nothing of the mailbox is kept.
    setLeaving(true);
    await api('/logout', { method: 'POST' }).catch(() => undefined);
    await clearSession(query);
    setOpened(false); setLeaving(false);
  }, [query]);

  if (!opened && !authenticated) {
    if (session.isPending) return <div className="full-state"><Mail aria-hidden /><p>正在打开…</p></div>;
    if (session.error) return <div className="full-state"><p>{session.error.message}</p><Button onClick={() => { void session.refetch(); }}>重试</Button></div>;
    return <Login onLogin={login} />;
  }
  const locked = !authenticated && !leaving;
  return <>
    <Mailbox locked={locked} onLogout={() => { void logout(); }} />
    {locked && <SessionLock onLogin={login} />}
  </>;
}

function Mailbox({ locked, onLogout }: { locked: boolean; onLogout: () => void }) {
  const query = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/folders') });
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api<UnreadCounts>('/counts') });
  const updateStatus = useQuery({ queryKey: ['update-status'], queryFn: () => api<UpdateState>('/updates/status'), enabled: !locked });
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (locked || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    void api<UpdateState>('/updates/open', json('POST', {})).then(state => query.setQueryData(['update-status'], state)).catch(() => {});
  }, [locked, query]);
  const [filter, setFilter] = useState<Filter>({ view: 'inbox' });
  const [expandedAccountId, setExpandedAccountId] = useState<string>();
  const [search, setSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selected, setSelected] = useState<Message | null>(null);
  const [accountForm, setAccountForm] = useState<{ id?: string } | null>(null);
  const [accountManager, setAccountManager] = useState(false);
  const [composer, setComposer] = useState<{ draft?: Draft; accountId?: string; fresh?: boolean } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [globalSettings, setGlobalSettings] = useState(false);
  const [versionDialog, setVersionDialog] = useState(false);
  const [mailActions, setMailActions] = useState<MailActionTarget | null>(null);
  const [creatingFolder, setCreatingFolder] = useState<MailActionTarget | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  const [deletingDraftBusy, setDeletingDraftBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noticePaused, setNoticePaused] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const readerHistoryRef = useRef(false);
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  // A flag change only returns once the mail server has taken it, which can be seconds. It is shown at
  // once from here and dropped when fresh list data has arrived, so a refetch in between cannot undo it.
  const [pendingFlags, setPendingFlags] = useState<Record<string, FlagPatch>>({});
  const searchBox = useRef<HTMLInputElement>(null);
  const composerOpen = useRef(false);
  composerOpen.current = !!composer;
  const covering = useMedia('(max-width: 850px)');
  const fail = useCallback((error: unknown) => setNotice({ text: (error as Error).message, kind: 'error' }), []);

  const messages = useInfiniteQuery({
    queryKey: ['messages', filter, searchTerm], initialPageParam: 0,
    queryFn: ({ pageParam }) => api<MessagePage>(`/messages?${new URLSearchParams({ ...filter, view: filter.view === 'drafts' ? 'all' : filter.view, q: searchTerm, offset: String(pageParam) })}`),
    getNextPageParam: page => page.nextOffset ?? undefined,
    enabled: filter.view !== 'drafts',
  });
  const drafts = useQuery({ queryKey: ['drafts', filter.accountId], queryFn: () => api<DraftSummary[]>(`/drafts${filter.accountId ? `?accountId=${filter.accountId}` : ''}`), enabled: filter.view === 'drafts' });
  const prepare = useMutation({ mutationFn: ({ messageId, mode, includeAttachments }: { messageId: string; mode: ComposeMode; includeAttachments: boolean }) => api<Draft>(`/messages/${messageId}/draft`, json('POST', { mode, includeAttachments, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })),
    onSuccess: draft => { openComposer({ draft, fresh: true }, '回复草稿已存入本地草稿。'); void query.invalidateQueries({ queryKey: ['drafts'] }); void query.invalidateQueries({ queryKey: ['counts'] }); }, onError: fail });
  const withPending = useCallback((message: Message) => pendingFlags[message.id] ? { ...message, ...pendingFlags[message.id] } : message, [pendingFlags]);
  const rows = useMemo(() => {
    // Pages are fetched one after another by offset; mail arriving in between shifts a message onto two pages.
    const seen = new Set<string>();
    return (messages.data?.pages.flatMap(page => page.messages) ?? []).filter(message => !seen.has(message.id) && !!seen.add(message.id)).map(withPending);
  }, [messages.data, withPending]);
  const selectedMessage = selected && (rows.find(message => message.id === selected.id) ?? withPending(selected));
  const accountList = useMemo(() => accounts.data ?? [], [accounts.data]);
  const canSend = accountList.some(account => account.sendEnabled);
  const canReceive = accountList.some(account => account.receiveEnabled);
  const folderRows = useMemo(() => folderList(folders.data ?? []), [folders.data]);
  // A removed mailbox never reports that its sync ended.
  const activeSync = useMemo(() => new Set([...syncing].filter(id => accountList.some(account => account.id === id && account.receiveEnabled))), [syncing, accountList]);

  /** Opens the composer unless one is already open, so a slow answer cannot replace a message being typed. */
  function openComposer(next: NonNullable<typeof composer>, otherwise: string) {
    if (composerOpen.current) setNotice({ text: otherwise, kind: 'success' }); else setComposer(next);
  }

  useEffect(() => {
    const next = search.trim();
    // Only a changed term closes the open message; otherwise opening one right after typing would be undone.
    if (next === searchTerm) return;
    const timer = setTimeout(() => { setSearchTerm(next); setSelected(null); }, 300);
    return () => clearTimeout(timer);
  }, [search, searchTerm]);

  const modalOpen = locked || mobileNav || !!accountManager || !!accountForm || globalSettings || versionDialog || !!deletingFolder || !!creatingFolder || !!composer || !!deletingDraftId;
  useEffect(() => { setNoticePaused(false); }, [notice]);
  useEffect(() => {
    const el = noticeRef.current;
    if (!el) return;
    const show = !!notice && !modalOpen;
    try {
      if (show) { if (!el.matches(':popover-open')) el.showPopover(); }
      else if (el.matches(':popover-open')) el.hidePopover();
    } catch { /* Safe fallback when Popover API is unavailable in tests. */ }
  }, [notice, modalOpen]);
  useEffect(() => {
    if (notice?.kind !== 'success' || noticePaused || modalOpen) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice, noticePaused, modalOpen]);

  useEffect(() => {
    const unread = counts.data?.inbox ?? 0;
    document.title = unread ? `(${unread}) ${pageTitle}` : pageTitle;
    return () => { document.title = pageTitle; };
  }, [counts.data?.inbox]);

  useEffect(() => {
    // Nothing is answered while logged out; the stream starts again once the lock is gone.
    if (locked) { setConnected(false); return; }
    let events: EventSource;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastEvent = 0;
    const pending = new Set<string>();
    const refresh = (keys = ['accounts', 'folders', 'messages', 'thread', 'counts', 'drafts']) => {
      keys.forEach(key => pending.add(key));
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; for (const key of pending) void query.invalidateQueries({ queryKey: [key] }); pending.clear(); }, 400);
    };
    const updateMessage = (event: Event) => {
      lastEvent = Date.now();
      const update = JSON.parse((event as MessageEvent<string>).data) as SyncEvent;
      if (update.type === 'settings') { refresh(['global-proxy', 'oauth-clients', 'update-settings', 'update-status']); return; }
      if (update.messageId) void query.invalidateQueries({ queryKey: ['body', update.messageId] });
      if (update.state) setSyncing(current => {
        const next = new Set(current);
        if (update.state === 'running') next.add(update.accountId); else next.delete(update.accountId);
        return next;
      });
      refresh(update.type === 'draft' ? ['drafts', 'counts'] : update.contentOnly ? ['messages', 'thread'] : update.type === 'sync' ? ['accounts'] : undefined);
    };
    const connect = () => {
      clearTimeout(retry);
      events = new EventSource('/api/events');
      events.addEventListener('ready', () => { lastEvent = Date.now(); setConnected(true); setSyncing(new Set()); refresh(); });
      events.addEventListener('ping', () => { lastEvent = Date.now(); });
      events.addEventListener('update', updateMessage);
      events.onerror = () => {
        setConnected(false); void query.invalidateQueries({ queryKey: ['session'] });
        // The browser reconnects after a dropped connection by itself, but gives up for good after an
        // HTTP error such as a proxy's 502 while the service restarts.
        if (events.readyState === EventSource.CLOSED) retry = setTimeout(connect, 5000);
      };
    };
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      // A phone back from sleep can hold a dead connection that still looks open; the server pings every 15 seconds.
      if (events.readyState !== EventSource.OPEN || Date.now() - lastEvent > 25_000) { events.close(); setConnected(false); connect(); }
      refresh(['session', 'accounts', 'folders', 'messages', 'thread', 'counts', 'drafts', 'body']);
    };
    connect();
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearTimeout(timer); clearTimeout(retry); events.close();
      window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume);
    };
  }, [query, locked]);

  const flag = useCallback(async (message: Message, patch: FlagPatch) => {
    setPendingFlags(current => ({ ...current, [message.id]: { ...current[message.id], ...patch } }));
    try {
      await api(`/messages/${message.id}/flags`, json('PATCH', patch));
      // The open message may not be in the list any more, for example after removing its star in the
      // starred view. Its own copy then has to carry the change.
      setSelected(current => current?.id === message.id ? { ...current, ...patch } : current);
    } catch (error) { fail(error); }
    await Promise.all([query.invalidateQueries({ queryKey: ['messages'] }), query.invalidateQueries({ queryKey: ['thread'] }), query.invalidateQueries({ queryKey: ['counts'] })]);
    setPendingFlags(current => {
      const rest = { ...current[message.id] };
      // A newer change to the same flag is still on its way; leave that one in place.
      for (const key of Object.keys(patch) as (keyof FlagPatch)[]) if (rest[key] === patch[key]) delete rest[key];
      const { [message.id]: _settled, ...others } = current;
      return Object.keys(rest).length ? { ...others, [message.id]: rest } : others;
    });
  }, [query, fail]);

  function clearReaderState() {
    setSelected(null);
    if (readerHistoryRef.current) {
      readerHistoryRef.current = false;
      history.back();
    }
  }
  function navigate(next: Filter) {
    setFilter(next); clearReaderState(); setMobileNav(false); setExpandedAccountId(next.accountId);
  }
  function toggleAccount(id: string) {
    if (expandedAccountId === id) { setExpandedAccountId(undefined); return; }
    setExpandedAccountId(id); setFilter({ view: 'inbox', accountId: id }); clearReaderState();
  }
  const select = useCallback((message: Message) => {
    setSelected(message);
    if (!message.seen && accountList.find(account => account.id === message.accountId)?.receiveEnabled) void flag(message, { seen: true });
  }, [flag, accountList]);
  const closeReader = useCallback(() => {
    const id = selected?.id;
    setSelected(null);
    if (readerHistoryRef.current) {
      readerHistoryRef.current = false;
      history.back();
    }
    // Back in the list, the keyboard continues from the message that was open.
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.focus({ preventScroll: true }));
  }, [selected?.id]);
  useEffect(() => {
    const onPopState = () => {
      if (!readerHistoryRef.current) return;
      readerHistoryRef.current = false;
      setSelected(current => {
        if (current) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-message-id="${current.id}"]`)?.focus({ preventScroll: true }));
        return null;
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  function syncAll() {
    for (const account of accountList) if (account.receiveEnabled) void api(`/accounts/${account.id}/sync`, { method: 'POST' }).catch(fail);
  }
  async function openDraft(id: string) {
    try { openComposer({ draft: await api<Draft>(`/drafts/${id}`) }, '先处理正在写的邮件，再打开这封草稿。'); }
    catch (error) { fail(error); void query.invalidateQueries({ queryKey: ['drafts'] }); }
  }
  async function confirmDeleteDraft() {
    if (!deletingDraftId) return;
    setDeletingDraftBusy(true);
    try { await api(`/drafts/${deletingDraftId}`, { method: 'DELETE' }); setDeletingDraftId(null); }
    catch (error) { fail(error); }
    finally { setDeletingDraftBusy(false); }
    await query.invalidateQueries({ queryKey: ['drafts'] }); await query.invalidateQueries({ queryKey: ['counts'] });
  }
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)');
    const resize = () => { if (!media.matches) setMobileNav(false); };
    media.addEventListener('change', resize); return () => media.removeEventListener('change', resize);
  }, []);

  const account = accountList.find(item => item.id === filter.accountId);
  const folder = folderRows.find(item => item.folder.id === filter.folderId);
  const isDrafts = filter.view === 'drafts';
  const replying = prepare.isPending || !canSend;
  const reply = prepare.mutate;

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open], [popover]:popover-open')) return;
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const open = !isDrafts && selectedMessage;
      const index = open ? rows.findIndex(message => message.id === open.id) : -1;
      const act: Record<string, (() => void) | false | null | undefined> = {
        Escape: open && closeReader,
        '/': !isDrafts && (() => searchBox.current?.focus()),
        c: canSend && (() => setComposer(current => current ?? { accountId: filter.accountId })),
        r: open && !replying && (() => reply({ messageId: open.id, mode: 'reply', includeAttachments: true })),
        a: open && !replying && (() => reply({ messageId: open.id, mode: 'reply-all', includeAttachments: true })),
        f: open && !replying && (() => reply({ messageId: open.id, mode: 'forward', includeAttachments: true })),
        j: !isDrafts && rows[index + 1] && (() => select(rows[index + 1])),
        k: !isDrafts && index > 0 && (() => select(rows[index - 1])),
      };
      const run = act[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (!run) return;
      event.preventDefault(); run();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [isDrafts, selectedMessage, rows, canSend, filter.accountId, replying, reply, select, closeReader]);

  const title = isDrafts ? '本地草稿' : searchTerm ? '搜索结果' : folder ? folder.label : account ? '收件箱' : filter.view === 'starred' ? '星标邮件' : filter.view === 'all' ? '所有邮件' : '统一收件箱';
  const total = isDrafts ? drafts.data?.length : messages.data?.pages[0]?.total;
  const scope = [!isDrafts && searchTerm && `“${searchTerm}”`, account ? account.name : accountList.length > 1 && '全部邮箱', total !== undefined && `${total} 封`].filter(Boolean).join(' · ');
  const accountMark = !account && accountList.length > 1 ? (accountId: string) => {
    const index = accountList.findIndex(item => item.id === accountId);
    return index < 0 ? undefined : { name: accountList[index].name, color: accountColor(index) };
  } : undefined;
  // An empty list means little while the first sync of what is being viewed has not finished.
  const stillSyncing = (account ? [account] : accountList).some(item => item.receiveEnabled && (activeSync.has(item.id) || (item.lastSync === null && !item.error)));
  const failing = accountList.filter(item => item.error);
  const empty = searchTerm ? <><Search size={30} strokeWidth={1.3} aria-hidden /><h3>没有找到相关邮件</h3><p>换个关键词试试。后台会逐步补全正文索引。</p></>
    : !accountList.length ? <><Inbox size={30} strokeWidth={1.3} aria-hidden /><h3>先连接一个邮箱</h3><p>连接后，邮件会同步到运行信屿的主机。</p><Button variant="primary" onClick={() => setAccountForm({})}><Plus size={15} aria-hidden />连接邮箱</Button></>
    : account?.receiveEnabled === false ? <><Send size={30} strokeWidth={1.3} aria-hidden /><h3>此邮箱仅用于发信</h3><p>需要收信时，可在邮箱设置中开启。</p></>
    : stillSyncing ? <><RefreshCw size={30} strokeWidth={1.3} className="spin" aria-hidden /><h3>正在同步邮件…</h3><p>第一次同步需要一些时间，来信会陆续出现在这里。</p></>
    : <><Inbox size={30} strokeWidth={1.3} aria-hidden /><h3>这里没有邮件</h3></>;
  const sidebarProps = { accounts: accountList, folders: folders.data ?? [], filter, syncing: activeSync, connected, counts: counts.data,
    expandedAccountId, onToggleAccount: toggleAccount,
    onNavigate: navigate, onClose: () => setMobileNav(false),
    onManageAccounts: () => { setMobileNav(false); setAccountManager(true); },
    onCompose: () => { setMobileNav(false); setComposer({ accountId: filter.accountId }); },
    onAddAccount: () => { setMobileNav(false); setAccountForm({}); },
    onGlobalSettings: () => { setMobileNav(false); setGlobalSettings(true); },
    onVersion: () => { setMobileNav(false); setVersionDialog(true); },
    updateAvailable: updateStatus.data?.result?.status === 'available',
    onActions: setMailActions,
    onLogout };
  const reading = !isDrafts && !!selectedMessage;
  useEffect(() => {
    if (!covering || !reading) return;
    if (!readerHistoryRef.current) {
      history.pushState({ ...(history.state && typeof history.state === 'object' ? history.state : {}), mailReader: true }, '');
      readerHistoryRef.current = true;
    }
  }, [covering, reading]);

  return <div className="mail-app" inert={locked}>
    <Sidebar {...sidebarProps} mobileOpen={false} />
    <Dialog.Root open={mobileNav} onOpenChange={setMobileNav}><Dialog.Portal>
      <Dialog.Overlay className="sidebar-backdrop" />
      <Dialog.Content className="mobile-sidebar-dialog" aria-describedby={undefined}><Dialog.Title className="sr-only">邮箱导航</Dialog.Title><Sidebar {...sidebarProps} mobileOpen /></Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    <main className={`workspace ${reading ? 'reading' : ''}`}>
      <header className="workspace-header">
        <Button className="mobile-menu" variant="ghost" aria-label="打开邮箱导航" aria-expanded={mobileNav} aria-controls={mobileNav ? 'mobile-mail-sidebar' : undefined} onClick={() => setMobileNav(true)}><Menu size={20} aria-hidden /></Button>
        <div className="header-title"><h1 title={title}>{title}</h1>{scope && <span>{scope}</span>}</div>
        <div className="header-actions">
          {!isDrafts && <search className="search-box">
            <Search size={16} aria-hidden />
            <input ref={searchBox} type="search" enterKeyHint="search" aria-label="搜索邮件" placeholder={account ? `在“${account.name}”中搜索` : '搜索全部邮箱'} value={search} onChange={event => setSearch(event.target.value)} />
            {search && <button type="button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={15} aria-hidden /></button>}
          </search>}
          {failing.length > 0 && <Button className="sync-alert" variant="ghost" aria-label={`${failing.length} 个邮箱同步失败，打开邮箱导航查看`} title={failing.map(item => `${item.name}：${item.error}`).join('\n')} onClick={() => setMobileNav(true)}><TriangleAlert size={17} aria-hidden /></Button>}
          <Button variant="ghost" aria-label="同步全部邮箱" title="同步全部邮箱" disabled={!canReceive || activeSync.size > 0} onClick={syncAll}><RefreshCw size={17} aria-hidden className={activeSync.size ? 'spin' : ''} /></Button>
        </div>
      </header>
      <div ref={noticeRef} popover="manual" className={notice ? `notice notice-${notice.kind}` : 'notice'}
        role={notice?.kind === 'error' ? 'alert' : 'status'}
        onMouseEnter={() => setNoticePaused(true)} onMouseLeave={() => setNoticePaused(false)}
        onFocus={() => setNoticePaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setNoticePaused(false); }}>
        {notice && <><span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} aria-hidden /></button></>}
      </div>
      {(accounts.error || folders.error) && <p className="error" role="alert">{accounts.error?.message || folders.error?.message}</p>}
      <div className="mail-panes">
        {/* While the reader covers the list on a narrow screen, the list is out of reach for keyboard and screen reader too. */}
        <section className="message-pane" inert={covering && reading}>
          {isDrafts ? drafts.isPending ? <p className="loading">正在读取草稿…</p> : drafts.error ? <p className="error">{drafts.error.message}</p>
            : <DraftList drafts={drafts.data ?? []} accounts={accountList} onOpen={id => { void openDraft(id); }} onDelete={id => setDeletingDraftId(id)} />
            : <MessageList key={JSON.stringify([filter, searchTerm])} messages={messages} rows={rows} selectedId={selected?.id} onSelect={select} accountMark={accountMark} empty={empty} />}
        </section>
        {isDrafts ? <section className="reader-empty"><FileText size={40} strokeWidth={1.1} aria-hidden /><p>选择一封草稿继续编辑</p><small>草稿保存在信屿服务端，可在其他设备继续编辑，不会同步到邮箱服务商。</small></section> : selectedMessage
          ? <Reader key={selectedMessage.id} message={selectedMessage} folders={folders.data ?? []} composing={replying} covering={covering} backLabel={title}
              receiving={accountList.find(account => account.id === selectedMessage.accountId)?.receiveEnabled ?? true}
              accountName={accountList.length > 1 ? accountList.find(item => item.id === selectedMessage.accountId)?.name : undefined}
              onReply={(mode, includeAttachments = true) => reply({ messageId: selectedMessage.id, mode, includeAttachments })}
              onBack={closeReader} onSelect={select} onFlag={patch => { void flag(selectedMessage, patch); }} onMoved={closeReader} />
          : <ReaderEmpty />}
      </div>
    </main>
    {deletingDraftId && <ConfirmModal title="删除这封草稿？" description="这封本地草稿和不再使用的附件将被永久删除。"
      confirmLabel={deletingDraftBusy ? '正在删除…' : '删除'} cancelLabel="取消" variant="danger" pending={deletingDraftBusy}
      onClose={() => setDeletingDraftId(null)} onConfirm={() => { void confirmDeleteDraft(); }} />}
    {accountManager && !accountForm && <Suspense fallback={null}><AccountManager accounts={accountList} onClose={() => setAccountManager(false)}
      onAdd={() => setAccountForm({})} onEdit={account => setAccountForm({ id: account.id })} onRemoved={id => {
        if (filter.accountId === id || selected?.accountId === id) navigate({ view: 'inbox' });
        else if (expandedAccountId === id) setExpandedAccountId(undefined);
      }} /></Suspense>}
    {accountForm && <Suspense fallback={null}><AccountForm accountId={accountForm.id} onClose={() => setAccountForm(null)} onSaved={id => navigate({ view: 'inbox', accountId: id })} /></Suspense>}
    {globalSettings && <Suspense fallback={null}><GlobalSettings onClose={() => setGlobalSettings(false)} onUpdates={() => { setGlobalSettings(false); setVersionDialog(true); }} /></Suspense>}
    {versionDialog && <Suspense fallback={null}><VersionDialog onClose={() => setVersionDialog(false)} /></Suspense>}
    {mailActions && <Suspense fallback={null}><MailActions target={mailActions} onClose={() => setMailActions(null)} onCreate={() => { setMobileNav(false); setCreatingFolder(mailActions); setMailActions(null); }}
      onDelete={() => { setMobileNav(false); setDeletingFolder(mailActions.folder!); setMailActions(null); }}
      onResult={(text, error) => setNotice({ text, kind: error ? 'error' : 'success' })} /></Suspense>}
    {deletingFolder && <Suspense fallback={null}><DeleteFolderDialog folder={deletingFolder} onClose={() => setDeletingFolder(null)} onDeleted={() => {
      const selectedFolder = folders.data?.find(folder => folder.id === filter.folderId);
      if (selectedFolder && (selectedFolder.id === deletingFolder.id || (deletingFolder.delimiter && selectedFolder.path.startsWith(`${deletingFolder.path}${deletingFolder.delimiter}`) && selectedFolder.accountId === deletingFolder.accountId))) navigate({ view: 'inbox', accountId: deletingFolder.accountId });
      setDeletingFolder(null); void query.invalidateQueries(); setNotice({ text: '文件夹已删除', kind: 'success' });
    }} /></Suspense>}
    {creatingFolder && <Suspense fallback={null}><CreateFolderDialog account={creatingFolder.account} parent={creatingFolder.folder} onClose={() => setCreatingFolder(null)} onCreated={folder => {
      setCreatingFolder(null); void query.invalidateQueries({ queryKey: ['folders'] });
      if (folder) navigate({ view: 'all', accountId: folder.accountId, folderId: folder.id });
      setNotice({ text: '文件夹已创建', kind: 'success' });
    }} /></Suspense>}
    {composer && <Suspense fallback={null}><Composer key={composer.draft?.id ?? 'new'} accounts={accountList} draft={composer.draft} accountId={composer.accountId} fresh={composer.fresh} onClose={() => setComposer(null)}
      onSent={(text, needsAttention) => setNotice({ text, kind: needsAttention ? 'error' : 'success' })} /></Suspense>}
  </div>;
}

async function clearSession(query: QueryClient) {
  await query.cancelQueries();
  // Preserve the active session observer so logout can render the login screen immediately.
  query.setQueryData(['session'], { authenticated: false });
  query.removeQueries({ predicate: item => item.queryKey[0] !== 'session' });
}
