import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import DOMPurify from 'dompurify';
import { Bold, Italic, List, Paperclip, Save, Send, Trash2, X } from 'lucide-react';
import { draftSchema, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, sendSchema, type Account, type Draft, type DraftInput, type Upload } from '@mail/shared';
import { api, json } from '../api';
import { describeIssues, fileSize } from '../format';
import { Button, Modal } from './ui';

const labels = { accountId: '发件人', to: '收件人', cc: '抄送', bcc: '密送', subject: '主题', text: '正文', html: '正文', attachmentIds: '附件' };

export function Composer({ accounts, draft, accountId, onClose, onSent }: { accounts: Account[]; draft?: Draft; accountId?: string; onClose: () => void; onSent: (notice: string) => void }) {
  const query = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draftId, setDraftId] = useState(draft?.id);
  const [attachments, setAttachments] = useState<Upload[]>(draft?.attachments ?? []);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(draft ? '已载入本地草稿' : '');
  const [error, setError] = useState('');
  const [showCopies, setShowCopies] = useState(!!(draft?.cc || draft?.bcc));
  const editor = useEditor({ extensions: [StarterKit], content: DOMPurify.sanitize(draft?.html ?? '', { FORBID_TAGS: ['img', 'style', 'iframe', 'video', 'audio'], FORBID_ATTR: ['style'] }),
    onUpdate: () => setDirty(true), editorProps: { attributes: { 'aria-label': '邮件正文', role: 'textbox' } } });
  const save = useMutation({ mutationFn: async (input: DraftInput) => {
    const saved = await api<Draft>(draftId ? `/drafts/${draftId}` : '/drafts', json(draftId ? 'PUT' : 'POST', input));
    setDraftId(saved.id); setDirty(false); setStatus('草稿已保存');
    void query.invalidateQueries({ queryKey: ['drafts'] }); void query.invalidateQueries({ queryKey: ['counts'] }); return saved;
  } });
  const upload = useMutation({ mutationFn: async (files: File[]) => {
    if (attachments.length + files.length > MAX_ATTACHMENTS) throw new Error(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
    if ([...attachments, ...files].reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 20 MiB');
    const added: Upload[] = [];
    try {
      for (const file of files) { const data = new FormData(); data.append('file', file); added.push(await api<Upload>('/uploads', { method: 'POST', body: data })); }
      return added;
    } catch (error) { await Promise.allSettled(added.map(file => api(`/uploads/${file.id}`, { method: 'DELETE' }))); throw error; }
  }, onSuccess: files => { setAttachments(current => [...current, ...files]); setDirty(true); } });
  const send = useMutation({ mutationFn: async (input: DraftInput) => {
    const addresses = (value: string) => value.split(/[,;，；\n]/).map(address => address.trim()).filter(Boolean);
    const parsed = sendSchema.safeParse({ ...input, to: addresses(input.to), cc: addresses(input.cc), bcc: addresses(input.bcc) });
    if (!parsed.success) throw new Error(describeIssues(parsed.error.issues, labels));
    const saved = await save.mutateAsync(input);
    return api<{ messageId: string; warning?: string }>('/send', json('POST', { ...parsed.data, draftId: saved.id }));
  }, onSuccess: result => { void query.invalidateQueries({ queryKey: ['drafts'] }); void query.invalidateQueries({ queryKey: ['counts'] }); onSent(result.warning ?? '邮件已发送'); onClose(); } });
  const discard = useMutation({ mutationFn: async () => {
    if (draftId) await api(`/drafts/${draftId}`, { method: 'DELETE' });
    await Promise.all(attachments.map(file => api(`/uploads/${file.id}`, { method: 'DELETE' })));
  }, onSuccess: () => { void query.invalidateQueries({ queryKey: ['drafts'] }); void query.invalidateQueries({ queryKey: ['counts'] }); onClose(); } });
  const busy = save.isPending || send.isPending || upload.isPending || discard.isPending;
  useEffect(() => { editor?.setEditable(!busy, false); }, [editor, busy]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  function input(): DraftInput | null {
    const fields = new FormData(form.current!);
    const parsed = draftSchema.safeParse({ accountId: fields.get('accountId'), to: fields.get('to') ?? '', cc: fields.get('cc') ?? '', bcc: fields.get('bcc') ?? '', subject: fields.get('subject') ?? '',
      text: editor?.getText() ?? '', html: editor?.getHTML(), inReplyTo: draft?.inReplyTo, references: draft?.references ?? [], attachmentIds: attachments.map(file => file.id) });
    if (!parsed.success) { setError(describeIssues(parsed.error.issues, labels)); return null; }
    setError(''); return parsed.data;
  }
  function saveCurrent(closeAfter = false) {
    const content = input(); if (content) save.mutate(content, { onSuccess: () => { if (closeAfter) onClose(); } });
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!busy) { const content = input(); if (content) send.mutate(content); } }
  function requestClose() {
    if (busy) return;
    if (!dirty) { onClose(); return; }
    if (window.confirm('保存为本地草稿并关闭？选择取消可继续编辑，或使用“丢弃”按钮。')) saveCurrent(true);
  }
  function shortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!busy) form.current?.requestSubmit(); }
  }
  function removeAttachment(file: Upload) {
    setAttachments(current => current.filter(item => item.id !== file.id)); setDirty(true);
    void api(`/uploads/${file.id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  return <Modal title={draft ? '编辑草稿' : '写邮件'} wide onClose={requestClose}>
    <form ref={form} className="composer" onSubmit={submit} onInput={() => setDirty(true)} onKeyDown={shortcut}>
      <fieldset className="form-fields" disabled={busy}>
        <label>发件人<select name="accountId" defaultValue={draft?.accountId ?? accountId ?? accounts[0]?.id}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select></label>
        <div className="compose-address"><div className="label-row"><label htmlFor="composer-to">收件人</label>{!showCopies && <button type="button" className="link-button" onClick={() => setShowCopies(true)}>添加抄送、密送</button>}</div><input id="composer-to" name="to" autoFocus={!draft} defaultValue={draft?.to ?? ''} placeholder="多个地址用逗号分隔" /></div>
        {showCopies && <div className="form-grid"><label>抄送<input name="cc" defaultValue={draft?.cc ?? ''} /></label><label>密送<input name="bcc" defaultValue={draft?.bcc ?? ''} /></label></div>}
        <label>主题<input name="subject" defaultValue={draft?.subject ?? ''} /></label>
        <div className="editor-wrap"><div className="editor-toolbar">
          <Button type="button" variant="ghost" aria-label="加粗" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></Button><Button type="button" variant="ghost" aria-label="斜体" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></Button><Button type="button" variant="ghost" aria-label="项目列表" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></Button>
          <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}><Paperclip size={16} />添加附件</Button>
          <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) upload.mutate(files); }} />
        </div><EditorContent editor={editor} /></div>
        {attachments.length > 0 && <ul className="compose-attachments">{attachments.map(file => <li key={file.id}><Paperclip size={14} /><a href={`/api/uploads/${file.id}`} download={file.filename}>{file.filename}</a><small>{fileSize(file.size)}</small><button type="button" aria-label={`移除附件 ${file.filename}`} onClick={() => removeAttachment(file)}><X size={15} /></button></li>)}</ul>}
      </fieldset>
      {(error || save.error || send.error || upload.error || discard.error) && <p className="error" role="alert">{error || send.error?.message || save.error?.message || upload.error?.message || discard.error?.message}</p>}
      <div className="compose-status" role="status">{upload.isPending ? '正在上传附件…' : dirty ? '有未保存的修改' : status}<span>附件合计不超过 20 MiB · Ctrl + Enter 发送</span></div>
      <div className="form-footer"><Button type="button" variant="ghost" disabled={busy} onClick={() => { if (window.confirm('丢弃这封邮件和它的本地草稿？')) discard.mutate(); }}><Trash2 size={16} />丢弃</Button><div className="button-row"><Button type="button" disabled={busy} onClick={() => saveCurrent()}><Save size={16} />{save.isPending ? '保存中…' : '保存草稿'}</Button><Button type="submit" variant="primary" disabled={busy}><Send size={16} />{send.isPending ? '正在发送…' : '发送'}</Button></div></div>
    </form>
  </Modal>;
}
