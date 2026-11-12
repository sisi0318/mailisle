import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Settings, Trash2 } from 'lucide-react';
import type { Account } from '@mail/shared';
import { api, json } from '../api';
import { accountColor } from '../format';
import { Button, Modal } from './ui';

type Props = {
  accounts: Account[];
  onClose: () => void;
  onAdd: () => void;
  onEdit: (account: Account) => void;
  onRemoved: (id: string) => void;
};

export function AccountManager({ accounts, onClose, onAdd, onEdit, onRemoved }: Props) {
  const query = useQueryClient();
  const [notice, setNotice] = useState('');
  const reorder = useMutation({
    mutationFn: (accountIds: string[]) => api<Account[]>('/accounts/order', json('PUT', { accountIds })),
    onSuccess: ordered => { query.setQueryData(['accounts'], ordered); setNotice('顺序已保存'); },
    onSettled: () => { void query.invalidateQueries({ queryKey: ['accounts'] }); },
  });
  const remove = useMutation({
    mutationFn: (account: Account) => api(`/accounts/${account.id}`, { method: 'DELETE' }),
    onSuccess: (_result, account) => {
      query.setQueryData<Account[]>(['accounts'], current => current?.filter(item => item.id !== account.id));
      query.removeQueries({ queryKey: ['account-settings', account.id] });
      onRemoved(account.id); setNotice('邮箱已移除'); void query.invalidateQueries();
    },
  });
  const busy = reorder.isPending || remove.isPending;
  function move(index: number, offset: number) {
    const ids = accounts.map(account => account.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    setNotice(''); remove.reset(); reorder.mutate(ids);
  }
  function removeAccount(account: Account) {
    if (!window.confirm(`移除“${account.name}”及它在本机的邮件索引、缓存和草稿？服务器上的邮件不受影响。`)) return;
    setNotice(''); reorder.reset(); remove.mutate(account);
  }
  return <Modal title="邮箱管理" description="调整顺序后自动保存。" onClose={() => { if (!busy) onClose(); }}>
    {accounts.length ? <ol className="account-manager-list">{accounts.map((account, index) => <li className="account-manager-row" key={account.id}>
      <div className="account-manager-summary" title={`${account.name}\n${account.email}`}>
        <span className="account-mark" style={{ background: accountColor(index) }} />
        <span className="account-text"><span>{account.name}</span><small>{account.email}</small>
          {(!account.receiveEnabled || !account.sendEnabled) && <small>{account.receiveEnabled ? '仅收信' : '仅发信'}</small>}
        </span>
      </div>
      <div className="account-manager-actions">
        <Button variant="ghost" disabled={busy || index === 0} aria-label={`上移 ${account.email}`} title="上移" onClick={() => move(index, -1)}><ArrowUp size={16} aria-hidden /></Button>
        <Button variant="ghost" disabled={busy || index === accounts.length - 1} aria-label={`下移 ${account.email}`} title="下移" onClick={() => move(index, 1)}><ArrowDown size={16} aria-hidden /></Button>
        <Button disabled={busy} aria-label={`设置 ${account.email}`} onClick={() => onEdit(account)}><Settings size={15} aria-hidden />设置</Button>
        <Button variant="danger" disabled={busy} aria-label={`删除邮箱 ${account.email}`} onClick={() => removeAccount(account)}><Trash2 size={15} aria-hidden />删除</Button>
      </div>
    </li>)}</ol> : <p className="muted">还没有添加邮箱。</p>}
    {(reorder.error || remove.error) && <p className="error" role="alert">{reorder.error?.message || remove.error?.message}</p>}
    <div className="form-footer"><span className="hint" role="status">{busy ? '正在保存…' : notice}</span>
      <Button disabled={busy} onClick={onAdd}><Plus size={16} aria-hidden />添加邮箱</Button>
    </div>
  </Modal>;
}
