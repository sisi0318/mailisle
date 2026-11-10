import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, List, Send } from 'lucide-react';
import { sendSchema, type Account, type Message, type SendInput } from '@mail/shared';
import { api, json } from '../api';
import { describeIssues } from '../format';
import { Button, Modal } from './ui';

const labels = { accountId: '发件人', to: '收件人', cc: '抄送', bcc: '密送', subject: '主题', text: '正文', html: '正文' };

export function Composer({ accounts, reply, onClose, onSent }: { accounts: Account[]; reply?: Message; onClose: () => void; onSent: (notice: string) => void }) {
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showCopies, setShowCopies] = useState(false);
  const editor = useEditor({ extensions: [StarterKit], content: '', onUpdate: () => setDirty(true),
    editorProps: { attributes: { 'aria-label': '邮件正文', role: 'textbox' } } });
  const send = useMutation({ mutationFn: (input: SendInput) => api<{ messageId: string; warning?: string }>('/send', json('POST', input)),
    onSuccess: result => { onSent(result.warning ?? '邮件已发送'); onClose(); } });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const recipients = (name: string) => String(form.get(name) ?? '').split(/[,;，；\n]/).map(value => value.trim()).filter(Boolean);
    const parsed = sendSchema.safeParse({ accountId: form.get('accountId'), to: recipients('to'), cc: recipients('cc'), bcc: recipients('bcc'),
      subject: form.get('subject'), text: editor?.getText() ?? '', html: editor?.getHTML(),
      inReplyTo: reply?.messageId || undefined, references: reply ? [...reply.references, reply.messageId].filter(Boolean) : [] });
    if (!parsed.success) { setError(describeIssues(parsed.error.issues, labels)); return; }
    setError('');
    send.mutate(parsed.data);
  }
  // Closing discards the text, and Esc is easy to hit by accident, so ask once something has been typed.
  function requestClose() {
    if (send.isPending) return;
    if (dirty && !window.confirm('放弃这封还没发出的邮件？')) return;
    onClose();
  }
  function shortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); }
  }

  const replyTo = reply && (reply.replyTo.length ? reply.replyTo : reply.from).map(address => address.address).join(', ');
  return <Modal title={reply ? '回复邮件' : '写邮件'} wide onClose={requestClose}>
    <form className="composer" onSubmit={submit} onInput={() => setDirty(true)} onKeyDown={shortcut}>
      {accounts.length > 1 && <label>发件人<select name="accountId" defaultValue={reply?.accountId ?? accounts[0]?.id}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select></label>}
      {accounts.length === 1 && <input type="hidden" name="accountId" value={accounts[0].id} />}
      <label><span className="label-row">收件人{!showCopies && <button type="button" className="link-button" onClick={() => setShowCopies(true)}>添加抄送、密送</button>}</span>
        <input name="to" required autoFocus={!reply} placeholder="多个地址用逗号分隔" defaultValue={replyTo} /></label>
      {showCopies && <div className="form-grid"><label>抄送<input name="cc" /></label><label>密送<input name="bcc" /></label></div>}
      <label>主题<input name="subject" defaultValue={reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : ''} /></label>
      <div className="editor-wrap">
        <div className="editor-toolbar">
          <Button type="button" variant="ghost" aria-label="加粗" title="加粗" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></Button>
          <Button type="button" variant="ghost" aria-label="斜体" title="斜体" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></Button>
          <Button type="button" variant="ghost" aria-label="项目列表" title="项目列表" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></Button>
        </div>
        <EditorContent editor={editor} />
      </div>
      {(error || send.error) && <p className="error" role="alert">{error || send.error?.message}</p>}
      <div className="form-footer">
        <span className="hint">Ctrl + Enter 发送。暂不支持附件和草稿。</span>
        <Button type="submit" variant="primary" disabled={send.isPending}><Send size={16} />{send.isPending ? '正在发送…' : '发送'}</Button>
      </div>
    </form>
  </Modal>;
}
