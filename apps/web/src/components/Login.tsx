import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { api, json } from '../api';
import { Button } from './ui';

function LoginForm({ title, lead, hint, passwordId, onLogin }: { title: string; lead?: string; hint: string; passwordId: string; onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const login = useMutation({ mutationFn: () => api('/login', json('POST', { password })), onSuccess: onLogin });
  return <form className="login-form" onSubmit={event => { event.preventDefault(); login.mutate(); }}>
    <span className="icon-tile"><LockKeyhole size={24} aria-hidden /></span><h2>{title}</h2>{lead && <p className="muted">{lead}</p>}
    <div className="field-group"><label htmlFor={passwordId}>登录密码</label><span className="password-field">
      <input id={passwordId} name="password" autoFocus type={visible ? 'text' : 'password'} autoComplete="current-password" enterKeyHint="done" value={password} onChange={event => setPassword(event.target.value)} required minLength={12} placeholder="输入启动时设置的密码" />
      <button type="button" aria-label="显示密码" aria-pressed={visible} title={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} aria-hidden /> : <Eye size={17} aria-hidden />}</button>
    </span></div>
    {login.error && <p role="alert" className="error">{login.error.message}</p>}
    <Button variant="primary" disabled={login.isPending} type="submit">{login.isPending ? '正在登录…' : '进入收件箱'}<ArrowRight size={17} aria-hidden /></Button>
    <p className="hint">{hint}</p>
  </form>;
}

export function Login({ onLogin }: { onLogin: () => void }) {
  return <main className="login-page"><div className="login-intro"><div className="brand"><Mail size={22} aria-hidden /><span>信屿</span></div>
    <p className="eyebrow">MailIsle</p><h1>所有来信，<br />有序相聚。</h1><div className="login-art" aria-hidden><div /><div /><div /><Mail size={42} strokeWidth={1} /></div><span className="login-footnote">你的邮件，存储在你的设备。</span></div>
    <div className="login-panel"><LoginForm passwordId="login-password" title="欢迎回到信屿" hint="首次登录使用 MAIL_MASTER_PASSWORD。" onLogin={onLogin} /></div></main>;
}

/**
 * Shown over the mailbox when the session runs out. The mailbox stays mounted underneath, so a message
 * being written is still there after logging in again. It is a dialog so that it also sits above, and
 * takes focus from, a composer that is open at that moment.
 */
export function SessionLock({ onLogin }: { onLogin: () => void }) {
  return <Dialog.Root open>
    <Dialog.Portal>
      <Dialog.Overlay className="session-lock-overlay" />
      <Dialog.Content className="session-lock" aria-describedby={undefined} onEscapeKeyDown={event => event.preventDefault()}
        onPointerDownOutside={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
        <Dialog.Title className="sr-only">重新登录</Dialog.Title>
        <LoginForm passwordId="session-lock-password" title="登录已过期" lead="重新登录后回到刚才的位置，正在写的邮件还在。" hint="登录状态在 7 天后到期。" onLogin={onLogin} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
