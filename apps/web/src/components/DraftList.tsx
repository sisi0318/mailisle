import { FileText, Trash2 } from 'lucide-react';
import type { Account, DraftSummary } from '@mail/shared';
import { listDate } from '../format';
import { Button } from './ui';

export function DraftList({ drafts, accounts, onOpen, onDelete }: { drafts: DraftSummary[]; accounts: Account[]; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  if (!drafts.length) return <div className="list-state"><FileText size={30} /><h3>没有本地草稿</h3></div>;
  return <div className="draft-list">{drafts.map(draft => <div className="draft-row" key={draft.id}>
    <button className="draft-open" onClick={() => onOpen(draft.id)}><strong>{draft.subject || '（无主题）'}</strong><span>发给：{draft.to || '尚未填写'}</span><small>{accounts.find(account => account.id === draft.accountId)?.name} · {listDate(draft.updatedAt)}{draft.attachmentCount > 0 ? ` · ${draft.attachmentCount} 个附件` : ''}</small></button>
    <Button variant="ghost" aria-label={`删除草稿 ${draft.subject || '无主题'}`} onClick={() => onDelete(draft.id)}><Trash2 size={16} /></Button>
  </div>)}</div>;
}
