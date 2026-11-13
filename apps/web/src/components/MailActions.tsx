import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, MailCheck, RefreshCw, Trash2 } from 'lucide-react';
import type { Account, Folder } from '@mail/shared';
import { api, json } from '../api';
import { Button, ConfirmModal, Modal } from './ui';

export type MailActionTarget = { account: Account; folder?: Folder; x: number; y: number; anchorTop?: number; anchorLeft?: number };

export function MailActions({ target, onClose, onCreate, onDelete, onResult }: { target: MailActionTarget; onClose: () => void; onCreate: () => void; onDelete: () => void; onResult: (text: string, error?: boolean) => void }) {
  const query = useQueryClient();
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const confirmingRef = useRef(false);
  const [confirmingReadAll, setConfirmingReadAll] = useState(false);
  const [pos, setPos] = useState<CSSProperties>();
  confirmingRef.current = confirmingReadAll;
  const { account, folder } = target;

  const mark = useMutation({
    mutationFn: () => api(folder ? `/folders/${folder.id}/read-all` : `/accounts/${account.id}/read-all`, json('POST', {})),
    onSuccess: () => { void query.invalidateQueries(); onResult('已标记为已读'); },
    onError: error => onResult(error.message, true),
    onSettled: () => onClose(),
  });
  const receive = useMutation({
    mutationFn: () => api(`/accounts/${account.id}/sync`, json('POST', {})),
    onSuccess: () => onResult('已请求收取邮件'),
    onError: error => onResult(error.message, true),
  });

  useEffect(() => {
    const el = menuRef.current;
    if (!el || confirmingReadAll) return;
    try { if (!el.matches(':popover-open')) el.showPopover(); } catch { /* Non-popover fallback */ }
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const width = rect.width || 240;
    const height = rect.height || 180;
    const anchorTop = target.anchorTop ?? target.y;
    const left = Math.max(pad, Math.min(target.x, window.innerWidth - width - pad));
    const top = target.y + height <= window.innerHeight - pad
      ? Math.max(pad, target.y)
      : Math.max(pad, Math.min(anchorTop - height, window.innerHeight - height - pad));
    setPos({ left, top });
    el.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === 'closed' && !confirmingRef.current) onClose();
    };
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, [target, confirmingReadAll, onClose]);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      menuRef.current?.hidePopover?.();
      return;
    }
    if ('focusGroup' in HTMLElement.prototype) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
  }

  function startReadAll() {
    confirmingRef.current = true;
    menuRef.current?.hidePopover?.();
    setConfirmingReadAll(true);
  }

  return <>
    {!confirmingReadAll && <div ref={menuRef} popover="auto" role="menu" focusgroup="menu nomemory" aria-labelledby={titleId}
      className="mail-actions-menu" style={pos} onKeyDown={keys}>
      <div id={titleId} className="mail-actions-title" title={folder?.path ?? account.name}>{folder?.path ?? account.name}</div>
      <p className="mail-actions-account" title={account.email}>{account.email}</p>
      <div className="mail-actions-items">
        {!folder && <button type="button" role="menuitem" disabled={!account.receiveEnabled} onClick={() => { receive.mutate(); menuRef.current?.hidePopover?.(); }}><RefreshCw size={16} aria-hidden />立即收取邮件</button>}
        <button type="button" role="menuitem" disabled={!account.receiveEnabled} onClick={startReadAll}><MailCheck size={16} aria-hidden />{folder ? '标记文件夹为已读' : '标记全部文件夹为已读'}</button>
        <button type="button" role="menuitem" disabled={!account.receiveEnabled} onClick={() => { confirmingRef.current = true; menuRef.current?.hidePopover?.(); onCreate(); }}><FolderPlus size={16} aria-hidden />{folder ? '新建子文件夹' : '新建文件夹'}</button>
        {folder && <button type="button" role="menuitem" className="mail-action-danger" disabled={!account.receiveEnabled || folder.role !== 'other'} title={folder.role !== 'other' ? '系统文件夹不能删除' : undefined} onClick={() => { confirmingRef.current = true; menuRef.current?.hidePopover?.(); onDelete(); }}><Trash2 size={16} aria-hidden />删除文件夹</button>}
      </div>
    </div>}
    {confirmingReadAll && <ConfirmModal title={folder ? `将“${folder.path}”标为已读？` : `将“${account.name}”标为已读？`}
      description={folder ? '这个文件夹中的全部未读邮件都会标为已读。' : '这个邮箱所有文件夹的未读邮件都会标为已读。'}
      confirmLabel={mark.isPending ? '正在标记…' : '标记为已读'} cancelLabel="取消" variant="primary" pending={mark.isPending}
      onClose={onClose} onConfirm={() => { onResult('正在标记为已读…'); mark.mutate(); }} />}
  </>;
}

export function DeleteFolderDialog({ folder, onClose, onDeleted }: { folder: Folder; onClose: () => void; onDeleted: () => void }) {
  const remove = useMutation({ mutationFn: () => api(`/folders/${folder.id}`, { method: 'DELETE' }), onSuccess: onDeleted });
  return <Modal title="删除文件夹" description={folder.path} dismissible={false} onClose={() => { if (!remove.isPending) onClose(); }}>
    <div className="delete-folder-warning"><p>此文件夹及其子文件夹将被删除。</p><p>邮箱服务器也会同步删除。</p><p>其中的邮件可能一并永久删除。</p><p>请先移走需要保留的邮件。</p></div>
    {remove.error && <p className="error" role="alert">{remove.error.message}</p>}
    <div className="form-footer"><Button autoFocus disabled={remove.isPending} onClick={onClose}>取消</Button><Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? '正在删除…' : '确认删除'}</Button></div>
  </Modal>;
}

export function CreateFolderDialog({ account, parent, onClose, onCreated }: { account: Account; parent?: Folder; onClose: () => void; onCreated: (folder?: Folder) => void }) {
  const [name, setName] = useState('');
  const create = useMutation({ mutationFn: () => api<{ folder?: Folder }>(`/accounts/${account.id}/folders`, json('POST', { name: name.trim(), parentId: parent?.id })),
    onSuccess: result => onCreated(result.folder) });
  return <Modal title={parent ? '新建子文件夹' : '新建文件夹'} description={`位置：${parent?.path ?? account.name}`} dismissible={false} onClose={() => { if (!create.isPending) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <label>文件夹名称<input autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={255} disabled={create.isPending} placeholder="例如：工作邮件" /></label>
      {create.error && <p className="error" role="alert">{create.error.message}</p>}
      <div className="form-footer"><Button type="button" disabled={create.isPending} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>{create.isPending ? '正在创建…' : '创建'}</Button></div>
    </form>
  </Modal>;
}
