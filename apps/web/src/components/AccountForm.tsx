import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountSchema, detectProvider, providerPresets, type AccountInput } from '@mail/shared';
import { api, json } from '../api';
import { describeIssues } from '../format';
import { Button, Modal } from './ui';

const labels = {
  name: '显示名称', email: '邮箱地址', proxy: '代理地址', sentCopy: '已发送副本',
  'imap.host': 'IMAP 服务器', 'imap.port': 'IMAP 端口', 'imap.security': 'IMAP 加密方式', 'imap.user': 'IMAP 登录名', 'imap.password': '密码',
  'smtp.host': 'SMTP 服务器', 'smtp.port': 'SMTP 端口', 'smtp.security': 'SMTP 加密方式', 'smtp.user': 'SMTP 登录名', 'smtp.password': '发信密码',
};

export function AccountForm({ onClose }: { onClose: () => void }) {
  const query = useQueryClient();
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [providerId, setProviderId] = useState('auto');
  // Server settings stay folded away while a preset fills them in; null means the user has not chosen either way.
  const [serversOpen, setServersOpen] = useState<boolean | null>(null);
  const detectedProvider = detectProvider(email);
  const provider = providerId === 'auto' ? detectedProvider : providerPresets.find(item => item.id === providerId);
  const add = useMutation({ mutationFn: (input: AccountInput) => api('/accounts', json('POST', input)),
    onSuccess: () => { void query.invalidateQueries(); onClose(); } });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const server = (protocol: 'imap' | 'smtp') => ({ host: value(`${protocol}Host`), port: Number(value(`${protocol}Port`)),
      security: value(`${protocol}Security`), user: value(`${protocol}User`) || value('email'), password: String(form.get(`${protocol}Password`) || form.get('password')) });
    const result = accountSchema.safeParse({ name: value('name') || provider?.name || value('email'), email: value('email'), imap: server('imap'), smtp: server('smtp'),
      proxy: value('proxy') || undefined, sentCopy: value('sentCopy') });
    if (!result.success) { setServersOpen(true); setError(describeIssues(result.error.issues, labels)); return; }
    setError('');
    add.mutate(result.data);
  }

  return <Modal title="连接邮箱" description="通过 IMAP 和 SMTP 连接，邮件会同步到这台设备。" onClose={() => { if (!add.isPending) onClose(); }} wide>
    <form onSubmit={submit} className="account-form">
      <div className="form-grid">
        <label>邮箱地址<input name="email" type="email" required autoFocus placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>显示名称（选填）<input name="name" placeholder={provider?.name ?? '例如：工作邮箱'} /></label>
      </div>
      <label>邮箱服务商<select value={providerId} onChange={event => { setProviderId(event.target.value); setServersOpen(null); setError(''); add.reset(); }}>
        <option value="auto">自动识别{detectedProvider ? `：${detectedProvider.name}` : ''}</option>
        {providerPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        <option value="custom">其他（手动填写服务器）</option>
      </select></label>
      {provider && <div className="provider-note" role="status"><strong>{provider.name}</strong><p>{provider.hint} <a href={provider.helpUrl} target="_blank" rel="noreferrer">查看帮助 ↗</a></p></div>}
      {!provider?.requiresOAuth && <label>{provider?.passwordLabel ?? '密码或授权码'}<input name="password" type="password" autoComplete="new-password" required placeholder={provider ? '' : 'QQ、163 等邮箱要用客户端授权码，不是登录密码'} /></label>}

      <details className="advanced" open={serversOpen ?? !provider}>
        <summary onClick={event => { event.preventDefault(); setServersOpen(!(serversOpen ?? !provider)); }}>服务器与高级设置{provider && <span>已按 {provider.name} 填好</span>}</summary>
        <div className="form-grid" key={provider?.id ?? 'custom'}>
          {(['imap', 'smtp'] as const).map(protocol => <fieldset key={protocol}>
            <legend>{protocol === 'imap' ? '收信（IMAP）' : '发信（SMTP）'}</legend>
            <label>服务器<input name={`${protocol}Host`} required placeholder={`${protocol}.example.com`} defaultValue={provider?.[protocol].host ?? ''} /></label>
            <div className="server-options">
              <label>端口<input name={`${protocol}Port`} type="number" min={1} max={65535} required defaultValue={provider?.[protocol].port ?? (protocol === 'imap' ? 993 : 465)} /></label>
              <label>加密<select name={`${protocol}Security`} defaultValue={provider?.[protocol].security ?? 'tls'}><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="plain">不加密（仅本机）</option></select></label>
            </div>
            <label>登录名（选填）<input name={`${protocol}User`} placeholder="默认用邮箱地址" /></label>
            {protocol === 'smtp' && <label>发信密码（选填）<input name="smtpPassword" type="password" autoComplete="new-password" placeholder="默认与上面相同" /></label>}
          </fieldset>)}
        </div>
        <label>已发送的邮件<select name="sentCopy" key={provider?.id ?? 'custom'} defaultValue={provider?.sentCopy ?? 'append'}>
          <option value="append">由本应用存入“已发送”（多数邮箱）</option>
          <option value="server">服务商会自动保存（Gmail、Outlook）</option>
        </select></label>
        <label>代理（选填）<input name="proxy" placeholder="socks5://127.0.0.1:1080 或 http://127.0.0.1:7890" /></label>
      </details>

      {(error || add.error) && <p className="error" role="alert">{error || add.error?.message}</p>}
      <div className="form-footer">
        <span className="hint">会先验证能否收信和发信，通过后才保存。密码加密存在本机。</span>
        <Button type="submit" variant="primary" disabled={add.isPending || provider?.requiresOAuth}>{provider?.requiresOAuth ? '暂不支持' : add.isPending ? '正在验证…' : '连接'}</Button>
      </div>
    </form>
  </Modal>;
}
