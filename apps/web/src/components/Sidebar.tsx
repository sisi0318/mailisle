import { Archive, Ban, ChevronRight, FileText, Folder as FolderIcon, Inbox, LogOut, Mail, Monitor, Moon, MoreHorizontal, Plus, RefreshCw, Send, Settings, SquarePen, Star, Sun, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { Account, Folder, FolderRole, UnreadCounts } from '@mail/shared';
import { accountColor, folderTree, type FolderNode } from '../format';
import { setTheme, useTheme, type Theme } from '../theme';
import { Button } from './ui';
import { frontendBuild } from '../version';
import type { MailActionTarget } from './MailActions';

export type Filter = { view: 'inbox' | 'all' | 'starred' | 'drafts'; accountId?: string; folderId?: string };

type Props = {
  accounts: Account[];
  folders: Folder[];
  filter: Filter;
  expandedAccountId?: string;
  onToggleAccount: (accountId: string) => void;
  syncing: Set<string>;
  connected: boolean;
  onNavigate: (filter: Filter) => void;
  onCompose: () => void;
  onAddAccount: () => void;
  onManageAccounts: () => void;
  onLogout: () => void;
  onGlobalSettings: () => void;
  onVersion: () => void;
  updateAvailable: boolean;
  onActions: (target: MailActionTarget) => void;
  counts?: UnreadCounts;
  mobileOpen: boolean;
  onClose: () => void;
};

const views = [
  { view: 'inbox', label: '统一收件箱', Icon: Inbox },
  { view: 'starred', label: '星标邮件', Icon: Star },
  { view: 'all', label: '所有邮件', Icon: Archive },
  { view: 'drafts', label: '本地草稿', Icon: FileText },
] as const;

const themes: Record<Theme, { label: string; Icon: LucideIcon; next: Theme }> = {
  system: { label: '跟随系统', Icon: Monitor, next: 'light' }, light: { label: '浅色', Icon: Sun, next: 'dark' }, dark: { label: '深色', Icon: Moon, next: 'system' },
};

const folderIcons: Record<FolderRole, LucideIcon> = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, junk: Ban, trash: Trash2, other: FolderIcon };

export function Sidebar({ accounts, folders, filter, expandedAccountId, onToggleAccount, syncing, connected, onNavigate, onCompose, onAddAccount, onManageAccounts, onLogout, onGlobalSettings, onVersion, updateAvailable, onActions, counts, mobileOpen, onClose }: Props) {
  const tree = useMemo(() => folderTree(folders), [folders]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const selectedFolder = folders.find(folder => folder.id === filter.folderId);
  useEffect(() => {
    const selected = selectedFolder;
    if (!selected?.delimiter) return;
    const delimiter = selected.delimiter;
    setExpandedFolders(current => {
      const next = new Set(current); let path = selected.path;
      while (path.includes(delimiter)) { path = path.slice(0, path.lastIndexOf(delimiter)); next.add(`${selected.accountId}:${path}`); }
      return next;
    });
  }, [selectedFolder?.path, selectedFolder?.delimiter, selectedFolder?.accountId]);
  const status = syncing.size ? '正在同步' : connected ? '已连接邮件服务' : '正在重新连接…';
  const theme = themes[useTheme()];
  function openActions(event: MouseEvent<HTMLButtonElement>, account: Account, folder?: Folder) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onActions({ account, folder, x: event.type === 'contextmenu' && event.clientX ? event.clientX : rect.right, y: event.type === 'contextmenu' && event.clientY ? event.clientY : rect.bottom });
  }
  function toggleFolder(key: string) {
    setExpandedFolders(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function renderFolder(node: FolderNode, account: Account) {
    const { folder, children, key, label } = node;
    const open = expandedFolders.has(key);
    const Icon = folderIcons[folder?.role ?? 'other'];
    return <li key={key}>
      <div className="folder-row">
        {children.length ? <button className="folder-toggle" aria-label={`${open ? '折叠' : '展开'} ${label}`} aria-expanded={open} onClick={() => toggleFolder(key)}><ChevronRight size={12} aria-hidden /></button> : <span className="folder-toggle-space" />}
        <button className={`folder-link ${folder && filter.folderId === folder.id ? 'active' : ''}`} title={node.path}
          onClick={() => { if (children.length) toggleFolder(key); if (folder) onNavigate({ view: 'all', accountId: account.id, folderId: folder.id }); }}
          onContextMenu={folder ? event => openActions(event, account, folder) : undefined}>
          <Icon size={14} /><span>{label}</span>{folder && !!counts?.folders[folder.id] && <small className="unread-count" aria-label={`${counts.folders[folder.id]} 封未读`}>{counts.folders[folder.id]}</small>}
        </button>
        {folder && <button className="mail-more" aria-label={`文件夹操作 ${folder.path}`} title="文件夹操作" onClick={event => openActions(event, account, folder)}><MoreHorizontal size={14} aria-hidden /></button>}
      </div>
      {!!children.length && open && <ul className="folder-children">{children.map(child => renderFolder(child, account))}</ul>}
    </li>;
  }
  return <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} id={mobileOpen ? 'mobile-mail-sidebar' : 'mail-sidebar'} aria-label="邮箱导航">
    <Button className="sidebar-close" variant="ghost" aria-label="关闭邮箱导航" onClick={onClose}><X size={20} /></Button>
    <div className="brand" title="MailIsle"><Mail size={22} /><span>信屿</span><button className={`local-badge app-version ${updateAvailable ? 'has-update' : ''}`} title={updateAvailable ? '发现可用更新' : '版本与更新'} aria-label={`自部署，版本 v${frontendBuild.version}，${updateAvailable ? '发现可用更新' : '检查更新'}`} onClick={onVersion}><span>自部署</span><span>v{frontendBuild.version}</span></button></div>
    <Button variant="primary" className="compose-button" disabled={!accounts.some(account => account.sendEnabled)} onClick={onCompose}><SquarePen size={17} /><span>写邮件</span></Button>

    <nav className="main-nav" aria-label="视图">
      {views.map(({ view, label, Icon }) => <button key={view} title={label} className={filter.view === view && !filter.accountId && !filter.folderId ? 'active' : ''} onClick={() => onNavigate({ view })}>
        <Icon size={17} /><span>{label}</span>{!!counts?.[view] && <small className="unread-count" aria-label={view === 'drafts' ? `${counts[view]} 封草稿` : `${counts[view]} 封未读`}>{counts[view]}</small>}
      </button>)}
    </nav>

    <div className="sidebar-label"><span>我的邮箱</span><div className="sidebar-actions">
      <button aria-label="邮箱管理" title="邮箱管理" onClick={onManageAccounts}><Settings size={16} aria-hidden /></button>
      <button aria-label="添加邮箱" title="添加邮箱" onClick={onAddAccount}><Plus size={16} aria-hidden /></button>
    </div></div>
    <div className="account-list">
      {accounts.map((account, index) => {
        const open = expandedAccountId === account.id;
        const selected = filter.accountId === account.id;
        const folderListId = `${mobileOpen ? 'mobile' : 'desktop'}-account-folders-${account.id}`;
        return <div className="account-group" key={account.id}>
          <div className="account-header">
          <button className={`account-button ${selected && (!open || (!filter.folderId && filter.view !== 'drafts')) ? 'active' : ''}`}
            aria-expanded={open} aria-controls={open ? folderListId : undefined} title={`${account.name}\n${account.email}`} onClick={() => onToggleAccount(account.id)} onContextMenu={event => openActions(event, account)}>
            <span className="account-mark" style={{ background: accountColor(index) }} />
            <span className="account-text"><span>{account.name}</span><small>{account.email}</small></span>
            {syncing.has(account.id) && <RefreshCw className="spin" size={13} aria-label="正在同步" />}
            {!!counts?.accounts[account.id] && <small className="unread-count" aria-label={`${counts.accounts[account.id]} 封未读`}>{counts.accounts[account.id]}</small>}
            <ChevronRight className="account-chevron" size={14} aria-hidden />
          </button>
          <button className="mail-more" aria-label={`邮箱操作 ${account.email}`} title="邮箱操作" onClick={event => openActions(event, account)}><MoreHorizontal size={15} aria-hidden /></button>
          </div>
          {account.error && <p className="account-error" role="status">{account.error}</p>}
          {open && <div className="folder-list" id={folderListId}>
            <ul className="folder-tree">{tree.filter(node => node.accountId === account.id).map(node => renderFolder(node, account))}</ul>
            <button className={selected && filter.view === 'drafts' ? 'active' : ''} onClick={() => onNavigate({ view: 'drafts', accountId: account.id })}><FileText size={14} /><span>本地草稿</span></button>
          </div>}
        </div>;
      })}
      <button className="add-account" onClick={onAddAccount}><Plus size={15} /><span>连接邮箱</span></button>
    </div>

    <div className="sidebar-bottom">
      <button onClick={onGlobalSettings} title="设置"><Settings size={14} /><span>设置</span></button>
      <button onClick={() => setTheme(theme.next)} title={`切换外观，下一个：${themes[theme.next].label}`}><theme.Icon size={14} aria-hidden /><span>外观：{theme.label}</span></button>
      <div role="status"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{status}</span></div>
      <button onClick={onLogout} title="退出登录"><LogOut size={14} /><span>退出登录</span></button>
    </div>
  </aside>;
}
