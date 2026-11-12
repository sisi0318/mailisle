import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderPlus, MailCheck, RefreshCw } from 'lucide-react';
import type { Account, Folder } from '@mail/shared';
import { api, json } from '../api';
import { Button, Modal } from './ui';

export type MailActionTarget = { account: Account; folder?: Folder; x: number; y: number };
export function MailActions({ target, onClose, onCreate, onResult }: { target: MailActionTarget; onClose: () => void; onCreate: () => void; onResult: (text: string, error?: boolean) => void }) {
  const query = useQueryClient();
  const { account, folder } = target;
  const mark = useMutation({ mutationFn: () => api(folder ? `/folders/${folder.id}/read-all` : `/accounts/${account.id}/read-all`, json('POST', {})),
    onSuccess: () => { void query.invalidateQueries(); onResult('已标记为已读'); }, onError: error => onResult(error.message, true) });
  const receive = useMutation({ mutationFn: () => api(`/accounts/${account.id}/sync`, json('POST', {})),
    onSuccess: () => onResult('已请求收取邮件'), onError: error => onResult(error.message, true) });
  function readAll() {
    if (!window.confirm(folder ? `将“${folder.path}”中的邮件全部标为已读？` : `将“${account.name}”所有文件夹的邮件标为已读？`)) return;
    onResult('正在标记为已读…'); mark.mutate(); onClose();
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="mail-actions-overlay" />
    <Dialog.Content className="mail-actions-menu" style={{ left: Math.max(8, Math.min(target.x, window.innerWidth - 248)), top: Math.max(8, Math.min(target.y, window.innerHeight - 190)) }} aria-describedby={undefined}>
      <Dialog.Title className="mail-actions-title" title={folder?.path ?? account.name}>{folder?.path ?? account.name}</Dialog.Title>
      <p className="mail-actions-account" title={account.email}>{account.email}</p>
      {!folder && <button disabled={!account.receiveEnabled} onClick={() => { receive.mutate(); onClose(); }}><RefreshCw size={16} aria-hidden />立即收取邮件</button>}
      <button disabled={!account.receiveEnabled} onClick={readAll}><MailCheck size={16} aria-hidden />{folder ? '标记文件夹为已读' : '标记全部文件夹为已读'}</button>
      <button disabled={!account.receiveEnabled} onClick={onCreate}><FolderPlus size={16} aria-hidden />{folder ? '新建子文件夹' : '新建文件夹'}</button>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function CreateFolderDialog({ account, parent, onClose, onCreated }: { account: Account; parent?: Folder; onClose: () => void; onCreated: (folder?: Folder) => void }) {
  const [name, setName] = useState('');
  const create = useMutation({ mutationFn: () => api<{ folder?: Folder }>(`/accounts/${account.id}/folders`, json('POST', { name: name.trim(), parentId: parent?.id })),
    onSuccess: result => onCreated(result.folder) });
  return <Modal title={parent ? '新建子文件夹' : '新建文件夹'} description={`位置：${parent?.path ?? account.name}`} onClose={() => { if (!create.isPending) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <label>文件夹名称<input autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={255} disabled={create.isPending} placeholder="例如：工作邮件" /></label>
      {create.error && <p className="error" role="alert">{create.error.message}</p>}
      <div className="form-footer"><Button type="button" disabled={create.isPending} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>{create.isPending ? '正在创建…' : '创建'}</Button></div>
    </form>
  </Modal>;
}
