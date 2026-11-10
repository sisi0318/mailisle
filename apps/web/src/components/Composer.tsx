import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, List, Send } from 'lucide-react';
import { sendSchema, type Account, type Message, type SendInput } from '@mail/shared';
import { api, json } from '../api';
import { Button, Modal } from './ui';

export function Composer({ accounts, reply, onClose, onSent }: { accounts: Account[]; reply?: Message; onClose: () => void; onSent: (notice: string) => void }) {
  const [error, setError] = useState('');
  const editor = useEditor({ extensions: [StarterKit], content: '', editorProps: { attributes: { 'aria-label': '邮件正文', role: 'textbox' } } });
  const send = useMutation({ mutationFn: (input: SendInput) => api<{ messageId: string; warning?: string }>('/send', json('POST', input)),
    onSuccess: result => { onSent(result.warning ?? '邮件已发送'); onClose(); } });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const recipients = (name: string) => String(form.get(name) ?? '').split(/[,;，；\n]/).map(value => value.trim()).filter(Boolean);
    const parsed = sendSchema.safeParse({ accountId: form.get('accountId'), to: recipients('to'), cc: recipients('cc'), bcc: recipients('bcc'),
      subject: form.get('subject'), text: editor?.getText() ?? '', html: editor?.getHTML(),
      inReplyTo: reply?.messageId || undefined, references: reply ? [...reply.references, reply.messageId].filter(Boolean) : [] });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')); return; }
    setError(''); send.mutate(parsed.data);
  }
  return <Modal title={reply ? '回复邮件' : '写一封新邮件'} description="与重要的人，保持联系。" wide onClose={() => { if (!send.isPending) onClose(); }}>
    <form className="composer" onSubmit={submit}>
      <label>发件人<select name="accountId" defaultValue={reply?.accountId ?? accounts[0]?.id}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select></label>
      <label>收件人<input name="to" required placeholder="邮箱地址，多个地址用逗号分隔" defaultValue={reply && (reply.replyTo.length ? reply.replyTo : reply.from).map(address => address.address).join(', ')} /></label>
      <div className="form-grid"><label>抄送<input name="cc" placeholder="选填" /></label><label>密送<input name="bcc" placeholder="选填" /></label></div>
      <label>主题<input name="subject" defaultValue={reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : ''} placeholder="给邮件一个主题" /></label>
      <div className="editor-wrap"><div className="editor-toolbar">
        <Button type="button" variant="ghost" aria-label="加粗" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={17} /></Button>
        <Button type="button" variant="ghost" aria-label="斜体" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={17} /></Button>
        <Button type="button" variant="ghost" aria-label="项目列表" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={17} /></Button>
      </div><EditorContent editor={editor} /></div>
      {(error || send.error) && <p className="error" role="alert">{error || send.error?.message}</p>}
      <div className="form-footer"><span className="hint">关闭窗口将丢弃未发送的内容。</span><Button type="submit" variant="primary" disabled={send.isPending}>{send.isPending ? '正在发送…' : '发送邮件'}<Send size={16} /></Button></div>
    </form>
  </Modal>;
}
