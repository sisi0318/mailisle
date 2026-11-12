import { Archive, Ban, ChevronRight, FileText, Folder as FolderIcon, Inbox, LogOut, Mail, Monitor, Moon, Plus, RefreshCw, Send, Settings, SquarePen, Star, Sun, Trash2, X, type LucideIcon } from 'lucide-react';
import type { Account, Folder, FolderRole, UnreadCounts } from '@mail/shared';
import { accountColor, folderList } from '../format';
import { setTheme, useTheme, type Theme } from '../theme';
import { Button } from './ui';

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
  onOAuthSettings: () => void;
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

export function Sidebar({ accounts, folders, filter, expandedAccountId, onToggleAccount, syncing, connected, onNavigate, onCompose, onAddAccount, onManageAccounts, onLogout, onOAuthSettings, counts, mobileOpen, onClose }: Props) {
  const allFolders = folderList(folders);
  const status = syncing.size ? '正在同步' : connected ? '已连接邮件服务' : '正在重新连接…';
  const theme = themes[useTheme()];
  return <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} id={mobileOpen ? 'mobile-mail-sidebar' : 'mail-sidebar'} aria-label="邮箱导航">
    <Button className="sidebar-close" variant="ghost" aria-label="关闭邮箱导航" onClick={onClose}><X size={20} /></Button>
    <div className="brand" title="MailIsle"><Mail size={22} /><span>信屿</span><span className="local-badge">自部署</span></div>
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
          <button className={`account-button ${selected && (!open || (!filter.folderId && filter.view !== 'drafts')) ? 'active' : ''}`}
            aria-expanded={open} aria-controls={open ? folderListId : undefined} title={`${account.name}\n${account.email}`} onClick={() => onToggleAccount(account.id)}>
            <span className="account-mark" style={{ background: accountColor(index) }} />
            <span className="account-text"><span>{account.name}</span><small>{account.email}</small></span>
            {syncing.has(account.id) && <RefreshCw className="spin" size={13} aria-label="正在同步" />}
            {!!counts?.accounts[account.id] && <small className="unread-count" aria-label={`${counts.accounts[account.id]} 封未读`}>{counts.accounts[account.id]}</small>}
            <ChevronRight className="account-chevron" size={14} aria-hidden />
          </button>
          {account.error && <p className="account-error" role="status">{account.error}</p>}
          {open && <div className="folder-list" id={folderListId}>
            {allFolders.filter(({ folder }) => folder.accountId === account.id).map(({ folder, label }) => {
              const Icon = folderIcons[folder.role];
              return <button key={folder.id} title={folder.path} className={filter.folderId === folder.id ? 'active' : ''} onClick={() => onNavigate({ view: 'all', accountId: account.id, folderId: folder.id })}>
                <Icon size={14} /><span>{label}</span>{!!counts?.folders[folder.id] && <small className="unread-count" aria-label={`${counts.folders[folder.id]} 封未读`}>{counts.folders[folder.id]}</small>}
              </button>;
            })}
            <button className={selected && filter.view === 'drafts' ? 'active' : ''} onClick={() => onNavigate({ view: 'drafts', accountId: account.id })}><FileText size={14} /><span>本地草稿</span></button>
          </div>}
        </div>;
      })}
      <button className="add-account" onClick={onAddAccount}><Plus size={15} /><span>连接邮箱</span></button>
    </div>

    <div className="sidebar-bottom">
      <button onClick={onOAuthSettings} title="OAuth 客户端设置"><Settings size={14} /><span>OAuth 客户端设置</span></button>
      <button onClick={() => setTheme(theme.next)} title={`切换外观，下一个：${themes[theme.next].label}`}><theme.Icon size={14} aria-hidden /><span>外观：{theme.label}</span></button>
      <div role="status"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{status}</span></div>
      <button onClick={onLogout} title="退出登录"><LogOut size={14} /><span>退出登录</span></button>
    </div>
  </aside>;
}
