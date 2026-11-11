import { useState } from 'react';
import { ArrowRight, LockKeyhole, Mail } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { api, json } from '../api';
import { Button } from './ui';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const login = useMutation({ mutationFn: () => api('/login', json('POST', { password })), onSuccess: onLogin });
  return <main className="login-page"><div className="login-intro"><div className="brand"><Mail size={22} /><span>信屿</span></div>
    <p className="eyebrow">MailIsle</p><h1>所有来信，<br />有序相聚。</h1><p>连接你的邮箱，把注意力留给真正重要的事。</p><div className="login-art"><div /><div /><div /><Mail size={42} strokeWidth={1} /></div><span className="login-footnote">你的邮件，存储在你的设备。</span></div>
    <div className="login-panel"><form onSubmit={event => { event.preventDefault(); login.mutate(); }}>
      <span className="icon-tile"><LockKeyhole size={24} /></span><h2>欢迎回到信屿</h2><p className="muted">登录你的私人邮件空间。</p>
      <label>登录密码<input autoFocus type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required minLength={12} placeholder="输入启动时设置的密码" /></label>
      {login.error && <p role="alert" className="error">{login.error.message}</p>}
      <Button variant="primary" disabled={login.isPending} type="submit">{login.isPending ? '正在登录…' : '进入收件箱'}<ArrowRight size={17} /></Button>
      <p className="hint">首次登录使用 MAIL_MASTER_PASSWORD。</p>
    </form></div></main>;
}
