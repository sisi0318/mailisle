import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import DOMPurify from 'dompurify';
import { Bold, Italic, List, Paperclip, Save, Send, Trash2, X } from 'lucide-react';
import { draftSchema, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, sendSchema, type Account, type Draft, type DraftInput, type Upload } from '@mail/shared';
import { api, ApiError, json } from '../api';
import { describeIssues, fileSize } from '../format';
import { Button, Modal } from './ui';

const labels = { accountId: '发件人', to: '收件人', cc: '抄送', bcc: '密送', subject: '主题', text: '正文', html: '正文', attachmentIds: '附件' };

// Markup from a stored draft or from the clipboard is laid out by this app's own stylesheet, so it
// brings no classes, IDs, inline styles or link targets with it.
const clean = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'iframe', 'video', 'audio'], FORBID_ATTR: ['style', 'class', 'id', 'target'] });
const escapeHtml = (text: string) => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);

function initialContent(draft?: Draft) {
  if (draft?.html) return clean(draft.html);
  // A draft that only has text, saved by something other than this editor, must not open empty.
  return (draft?.text ?? '').split(/\n{2,}/).filter(block => block.trim()).map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('');
}

/** Accepts `name <address>` as copied from another mail client, next to bare addresses. */
const addresses = (value: string) => value.split(/[,;，；\n]/).map(part => (/<([^<>]+)>\s*$/.exec(part)?.[1] ?? part).trim()).filter(Boolean);
const isEmpty = (content: DraftInput) => ![content.to, content.cc, content.bcc, content.subject, content.text].some(value => value.trim()) && !content.attachmentIds.length;

type Props = {
  accounts: Account[];
  draft?: Draft;
  accountId?: string;
  /** The draft was just created for a reply or forward and nobody has decided to keep it yet. */
  fresh?: boolean;
  onClose: () => void;
  onSent: (notice: string, needsAttention: boolean) => void;
};

export function Composer({ accounts, draft, accountId, fresh = false, onClose, onSent }: Props) {
  const query = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Requests read the ID from here: a save queued behind another one must see the ID the first one created.
  const draftId = useRef(draft?.id);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const [saved, setSaved] = useState(!!draft);
  const [attachments, setAttachments] = useState<Upload[]>(draft?.attachments ?? []);
  const [dirty, setDirty] = useState(false);
  const [autosaves, setAutosaves] = useState(0);
  const [status, setStatus] = useState(draft && !fresh ? '已载入本地草稿' : '');
  const [error, setError] = useState('');
  const [showCopies, setShowCopies] = useState(!!(draft?.cc || draft?.bcc));
  const [asking, setAsking] = useState<'close' | 'delete' | null>(null);
  const changed = () => { revision.current++; setDirty(true); };
  const refreshLists = () => { void query.invalidateQueries({ queryKey: ['drafts'] }); void query.invalidateQueries({ queryKey: ['counts'] }); };

  const editor = useEditor({
    // Links are not opened from the editor: a page opened that way would receive a reference to this window.
    extensions: [StarterKit.configure({ link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer', target: null, class: null } } })],
    content: initialContent(draft), onUpdate: changed,
    editorProps: { attributes: { 'aria-label': '邮件正文', role: 'textbox', 'aria-multiline': 'true' }, transformPastedHTML: clean },
  });
  const active = useEditorState({ editor, selector: state => ({ bold: !!state.editor?.isActive('bold'), italic: !!state.editor?.isActive('italic'), list: !!state.editor?.isActive('bulletList') }) });

  /** Saves one after another, so that two saves of a new message cannot create two drafts. */
  function persist(content: DraftInput): Promise<Draft> {
    const run = saving.current.catch(() => undefined).then(async () => {
      const id = draftId.current;
      let result: Draft;
      try { result = await api<Draft>(id ? `/drafts/${id}` : '/drafts', json(id ? 'PUT' : 'POST', content)); }
      catch (failure) {
        // Deleted on another device while it was open here. What is on screen is kept as a new draft.
        if (!id || !(failure instanceof ApiError) || failure.status !== 404) throw failure;
        result = await api<Draft>('/drafts', json('POST', content));
      }
      draftId.current = result.id; setSaved(true); refreshLists();
      return result;
    });
    saving.current = run;
    return run;
  }
  const save = useMutation({ mutationFn: async (content: DraftInput) => {
    const at = revision.current;
    const result = await persist(content);
    if (revision.current === at) setDirty(false);
    setStatus('草稿已保存');
    return result;
  } });
  const upload = useMutation({ mutationFn: async (files: File[]) => {
    if (attachments.length + files.length > MAX_ATTACHMENTS) throw new Error(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
    if ([...attachments, ...files].reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 20 MiB');
    const added: Upload[] = [];
    try {
      for (const file of files) { const data = new FormData(); data.append('file', file); added.push(await api<Upload>('/uploads', { method: 'POST', body: data })); }
      return added;
    } catch (failure) { await Promise.allSettled(added.map(file => api(`/uploads/${file.id}`, { method: 'DELETE' }))); throw failure; }
  }, onSuccess: files => { setAttachments(current => [...current, ...files]); changed(); } });
  const send = useMutation({ mutationFn: async (content: DraftInput) => {
    const parsed = sendSchema.safeParse({ ...content, to: addresses(content.to), cc: addresses(content.cc), bcc: addresses(content.bcc) });
    if (!parsed.success) throw new Error(describeIssues(parsed.error.issues, labels));
    const result = await save.mutateAsync(content);
    return api<{ messageId: string; warning?: string }>('/send', json('POST', { ...parsed.data, draftId: result.id }));
  }, onSuccess: result => { refreshLists(); onSent(result.warning ?? '邮件已发送', !!result.warning); onClose(); } });
  const discard = useMutation({ mutationFn: async () => {
    // An autosave still on its way would otherwise create the draft again right after it was deleted.
    await saving.current.catch(() => undefined);
    const id = draftId.current;
    // Deleted elsewhere already is what was asked for.
    if (id) await api(`/drafts/${id}`, { method: 'DELETE' }).catch(failure => { if (!(failure instanceof ApiError) || failure.status !== 404) throw failure; });
    await Promise.allSettled(attachments.map(file => api(`/uploads/${file.id}`, { method: 'DELETE' })));
  }, onSuccess: () => { refreshLists(); onClose(); } });
  const busy = save.isPending || send.isPending || upload.isPending || discard.isPending;

  useEffect(() => { editor?.setEditable(!busy, false); }, [editor, busy]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  // Saves in the background a few seconds after a change, without disabling the form the way a manual save does.
  useEffect(() => {
    if (!dirty || busy || asking) return;
    const timer = setTimeout(() => {
      const content = read();
      // Nothing worth keeping yet, or a field over its limit; a manual save says what is wrong.
      if (!content.success || isEmpty(content.data)) return;
      const at = revision.current;
      persist(content.data).then(() => { if (revision.current === at) setDirty(false); setStatus('已自动保存'); }, () => setStatus('自动保存失败，请手动保存草稿'))
        .finally(() => setAutosaves(count => count + 1));
    }, 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read() and persist() only reach refs and the values listed here.
  }, [dirty, busy, asking, autosaves, attachments, editor]);

  function read() {
    const fields = new FormData(form.current!);
    return draftSchema.safeParse({ accountId: fields.get('accountId'), to: fields.get('to') ?? '', cc: fields.get('cc') ?? '', bcc: fields.get('bcc') ?? '', subject: fields.get('subject') ?? '',
      text: editor?.getText() ?? '', html: editor?.getHTML(), inReplyTo: draft?.inReplyTo, references: draft?.references ?? [], attachmentIds: attachments.map(file => file.id) });
  }
  function input(): DraftInput | null {
    const parsed = read();
    if (!parsed.success) { setError(describeIssues(parsed.error.issues, labels)); return null; }
    setError(''); return parsed.data;
  }
  function saveCurrent(closeAfter = false) {
    const content = input();
    if (content) save.mutate(content, { onSuccess: () => { if (closeAfter) onClose(); } });
    setAsking(null);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const content = input();
    if (!content) return;
    if (!content.subject.trim() && !window.confirm('这封邮件没有主题，仍然发送吗？')) return;
    send.mutate(content);
  }
  function requestClose() {
    if (busy) return;
    if (dirty) { setAsking('close'); return; }
    // A reply or forward that was opened and closed untouched does not leave a draft behind.
    if (fresh && revision.current === 0) { discard.mutate(); return; }
    onClose();
  }
  function closeWithoutSaving() {
    setAsking(null);
    // With no saved draft there is nothing to go back to, so the uploads are removed as well.
    if (draftId.current) onClose(); else discard.mutate();
  }
  function shortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'Enter') { event.preventDefault(); if (!busy) form.current?.requestSubmit(); }
    if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy) saveCurrent(); }
  }
  function removeAttachment(file: Upload) {
    setAttachments(current => current.filter(item => item.id !== file.id)); changed();
    void api(`/uploads/${file.id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  const format = (label: string, pressed: boolean | undefined, run: () => void, icon: ReactNode) =>
    <Button type="button" variant="ghost" aria-label={label} title={label} aria-pressed={!!pressed} className={pressed ? 'active' : ''} onClick={run}>{icon}</Button>;

  return <Modal title={draft && !fresh ? '编辑草稿' : '写邮件'} wide className="composer-modal" onClose={requestClose}>
    <form ref={form} className="composer" onSubmit={submit} onInput={changed} onKeyDown={shortcut}>
      <fieldset className="form-fields" disabled={busy}>
        <label>发件人<select name="accountId" defaultValue={draft?.accountId ?? accountId ?? accounts[0]?.id}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select></label>
        <div className="compose-address"><div className="label-row"><label htmlFor="composer-to">收件人</label>{!showCopies && <button type="button" className="link-button" onClick={() => setShowCopies(true)}>添加抄送、密送</button>}</div><input id="composer-to" name="to" autoFocus={!draft} defaultValue={draft?.to ?? ''} placeholder="多个地址用逗号分隔" /></div>
        {showCopies && <div className="form-grid"><label>抄送<input name="cc" defaultValue={draft?.cc ?? ''} /></label><label>密送<input name="bcc" defaultValue={draft?.bcc ?? ''} /></label></div>}
        <label>主题<input name="subject" defaultValue={draft?.subject ?? ''} /></label>
        <div className="editor-wrap"><div className="editor-toolbar">
          {format('加粗', active?.bold, () => editor?.chain().focus().toggleBold().run(), <Bold size={16} aria-hidden />)}
          {format('斜体', active?.italic, () => editor?.chain().focus().toggleItalic().run(), <Italic size={16} aria-hidden />)}
          {format('项目列表', active?.list, () => editor?.chain().focus().toggleBulletList().run(), <List size={16} aria-hidden />)}
          <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}><Paperclip size={16} aria-hidden />添加附件</Button>
          <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) upload.mutate(files); }} />
        </div><EditorContent editor={editor} /></div>
        {attachments.length > 0 && <ul className="compose-attachments">{attachments.map(file => <li key={file.id}><Paperclip size={14} aria-hidden /><a href={`/api/uploads/${file.id}`} download={file.filename}>{file.filename}</a><small>{fileSize(file.size)}</small><button type="button" aria-label={`移除附件 ${file.filename}`} onClick={() => removeAttachment(file)}><X size={15} aria-hidden /></button></li>)}</ul>}
      </fieldset>
      <div className="composer-bottom">
        {(error || save.error || send.error || upload.error || discard.error) && <p className="error" role="alert">{error || send.error?.message || save.error?.message || upload.error?.message || discard.error?.message}</p>}
        <div className="compose-status" role="status">{upload.isPending ? '正在上传附件…' : dirty ? '有未保存的修改' : status}<span>附件合计不超过 20 MiB · Ctrl + Enter 发送 · Ctrl + S 保存</span></div>
        <div className="form-footer"><Button type="button" variant="ghost" disabled={busy} onClick={() => setAsking('delete')}><Trash2 size={16} aria-hidden />{saved ? '删除草稿' : '丢弃'}</Button><div className="button-row"><Button type="button" disabled={busy} onClick={() => saveCurrent()}><Save size={16} aria-hidden />{save.isPending ? '保存中…' : '保存草稿'}</Button><Button type="submit" variant="primary" disabled={busy}><Send size={16} aria-hidden />{send.isPending ? '正在发送…' : '发送'}</Button></div></div>
      </div>
    </form>
    {asking === 'close' && <Modal title="保存这封邮件吗？" description={saved ? '上次保存之后还有修改。' : '这封邮件还没有保存。'} onClose={() => setAsking(null)}>
      <div className="button-row confirm-actions"><Button onClick={() => setAsking(null)}>继续编辑</Button><Button onClick={closeWithoutSaving}>{saved ? '不保存最近的修改' : '不保存'}</Button><Button variant="primary" autoFocus onClick={() => saveCurrent(true)}>保存草稿并关闭</Button></div>
    </Modal>}
    {asking === 'delete' && <Modal title="删除这封邮件？" description="邮件内容、已保存的草稿和添加的附件都会删除，无法恢复。" onClose={() => setAsking(null)}>
      <div className="button-row confirm-actions"><Button autoFocus onClick={() => setAsking(null)}>取消</Button><Button variant="danger" onClick={() => { setAsking(null); discard.mutate(); }}>删除</Button></div>
    </Modal>}
  </Modal>;
}
