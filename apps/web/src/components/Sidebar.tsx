import { Archive, Ban, FileText, Folder as FolderIcon, Inbox, LogOut, Mail, Plus, RefreshCw, Send, Settings, SquarePen, Star, Trash2, X, type LucideIcon } from 'lucide-react';
import type { Account, Folder, FolderRole, UnreadCounts } from '@mail/shared';
import { accountColor, folderList } from '../format';
import { Button } from './ui';

export type Filter = { view: 'inbox' | 'all' | 'starred' | 'drafts'; accountId?: string; folderId?: string };

type Props = {
  accounts: Account[];
  folders: Folder[];
  filter: Filter;
  syncing: Set<string>;
  connected: boolean;
  onNavigate: (filter: Filter) => void;
  onCompose: () => void;
  onAddAccount: () => void;
  onRemoveAccount: (account: Account) => void;
  onEditAccount: (account: Account) => void;
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

const folderIcons: Record<FolderRole, LucideIcon> = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, junk: Ban, trash: Trash2, other: FolderIcon };

export function Sidebar({ accounts, folders, filter, syncing, connected, onNavigate, onCompose, onAddAccount, onRemoveAccount, onEditAccount, onLogout, onOAuthSettings, counts, mobileOpen, onClose }: Props) {
  const allFolders = folderList(folders);
  const status = syncing.size ? '正在同步' : connected ? '已连接本机服务' : '正在重新连接…';
  return <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} id={mobileOpen ? 'mobile-mail-sidebar' : 'mail-sidebar'} aria-label="邮箱导航">
    <Button className="sidebar-close" variant="ghost" aria-label="关闭邮箱导航" onClick={onClose}><X size={20} /></Button>
    <div className="brand" title="MailIsle"><Mail size={22} /><span>信屿</span><span className="local-badge">本机</span></div>
    <Button variant="primary" className="compose-button" disabled={!accounts.length} onClick={onCompose}><SquarePen size={17} /><span>写邮件</span></Button>

    <nav className="main-nav" aria-label="视图">
      {views.map(({ view, label, Icon }) => <button key={view} title={label} className={filter.view === view && !filter.accountId && !filter.folderId ? 'active' : ''} onClick={() => onNavigate({ view })}>
        <Icon size={17} /><span>{label}</span>{!!counts?.[view] && <small className="unread-count" aria-label={view === 'drafts' ? `${counts[view]} 封草稿` : `${counts[view]} 封未读`}>{counts[view]}</small>}
      </button>)}
    </nav>

    <div className="sidebar-label"><span>我的邮箱</span><button aria-label="添加邮箱" title="添加邮箱" onClick={onAddAccount}><Plus size={16} /></button></div>
    <div className="account-list">
      {accounts.map((account, index) => {
        const open = filter.accountId === account.id;
        return <div className="account-group" key={account.id}>
          <button className={`account-button ${open && !filter.folderId ? 'active' : ''}`} aria-expanded={open} onClick={() => onNavigate({ view: 'inbox', accountId: account.id })}>
            <span className="account-mark" style={{ background: accountColor(index) }} />
            <span className="account-text"><span>{account.name}</span><small>{account.email}</small></span>
            {syncing.has(account.id) && <RefreshCw className="spin" size={13} aria-label="正在同步" />}
            {!!counts?.accounts[account.id] && <small className="unread-count" aria-label={`${counts.accounts[account.id]} 封未读`}>{counts.accounts[account.id]}</small>}
          </button>
          {account.error && <p className="account-error" role="status">{account.error}</p>}
          {open && <div className="folder-list">
            {allFolders.filter(({ folder }) => folder.accountId === account.id).map(({ folder, label }) => {
              const Icon = folderIcons[folder.role];
              return <button key={folder.id} title={folder.path} className={filter.folderId === folder.id ? 'active' : ''} onClick={() => onNavigate({ view: 'all', accountId: account.id, folderId: folder.id })}>
                <Icon size={14} /><span>{label}</span>{!!counts?.folders[folder.id] && <small className="unread-count" aria-label={`${counts.folders[folder.id]} 封未读`}>{counts.folders[folder.id]}</small>}
              </button>;
            })}
            <button onClick={() => onNavigate({ view: 'drafts', accountId: account.id })}><FileText size={14} /><span>本地草稿</span></button>
            <button onClick={() => onEditAccount(account)}><Settings size={14} /><span>邮箱设置</span></button>
            <button className="remove-account" onClick={() => onRemoveAccount(account)}>移除此邮箱…</button>
          </div>}
        </div>;
      })}
      <button className="add-account" onClick={onAddAccount}><Plus size={15} /><span>连接邮箱</span></button>
    </div>

    <div className="sidebar-bottom">
      <button onClick={onOAuthSettings} title="OAuth 客户端设置"><Settings size={14} /><span>OAuth 客户端设置</span></button>
      <div role="status"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{status}</span></div>
      <button onClick={onLogout} title="退出登录"><LogOut size={14} /><span>退出登录</span></button>
    </div>
  </aside>;
}
