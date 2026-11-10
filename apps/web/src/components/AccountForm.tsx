import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountSchema, detectProvider, providerPresets, type AccountInput } from '@mail/shared';
import { api, json } from '../api';
import { Button, Modal } from './ui';

export function AccountForm({ onClose }: { onClose: () => void }) {
  const query = useQueryClient();
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [providerId, setProviderId] = useState('auto');
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
    const result = accountSchema.safeParse({ name: value('name'), email: value('email'), imap: server('imap'), smtp: server('smtp'),
      proxy: value('proxy') || undefined, sentCopy: value('sentCopy') });
    if (!result.success) { setError(result.error.issues.map(issue => issue.message).join('；')); return; }
    setError(''); add.mutate(result.data);
  }
  return <Modal title="连接邮箱" description="使用 IMAP / SMTP，邮件会同步到这台设备。" onClose={() => { if (!add.isPending) onClose(); }} wide>
    <form onSubmit={submit} className="account-form">
      <div className="form-grid"><label>显示名称<input name="name" required placeholder="例如：工作邮箱" /></label><label>邮箱地址<input name="email" type="email" required placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} /></label></div>
      <label>邮箱服务商<select value={providerId} onChange={event => { setProviderId(event.target.value); setError(''); add.reset(); }}>
        <option value="auto">按邮箱后缀自动识别{detectedProvider ? ` · ${detectedProvider.name}` : ''}</option>
        {providerPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        <option value="custom">其他 / 手动配置</option>
      </select></label>
      {provider ? <div className="provider-note" role="status"><strong>{provider.name}</strong><p>{provider.hint} <a href={provider.helpUrl} target="_blank" rel="noreferrer">查看帮助 ↗</a></p><small>服务器参数已预填，仍可直接修改。</small></div>
        : <p className="hint">输入常见邮箱地址后会自动填写服务器参数；自定义域名可手动选择服务商，或填写下方设置。</p>}
      {!provider?.requiresOAuth && <label>{provider?.passwordLabel ?? '密码 / 授权码'}<input name="password" type="password" autoComplete="new-password" required placeholder={provider ? `输入${provider.passwordLabel}` : 'QQ、163 等邮箱请使用客户端授权码'} /></label>}
      <div className="form-grid" key={provider?.id ?? 'custom'}>{(['imap', 'smtp'] as const).map(protocol => <fieldset key={protocol}><legend>{protocol.toUpperCase()} · {protocol === 'imap' ? '收信' : '发信'}</legend>
        <label>服务器<input name={`${protocol}Host`} required placeholder={`${protocol}.example.com`} defaultValue={provider?.[protocol].host ?? ''} /></label>
        <div className="server-options"><label>端口<input name={`${protocol}Port`} type="number" min={1} max={65535} required defaultValue={provider?.[protocol].port ?? (protocol === 'imap' ? 993 : 465)} /></label>
          <label>加密<select name={`${protocol}Security`} defaultValue={provider?.[protocol].security ?? 'tls'}><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="plain">明文（仅本机）</option></select></label></div>
        <label>登录名（选填）<input name={`${protocol}User`} placeholder="默认使用邮箱地址" /></label>
        {protocol === 'smtp' && <label>独立发信密码（选填）<input name="smtpPassword" type="password" autoComplete="new-password" placeholder="默认使用上面的密码" /></label>}
      </fieldset>)}</div>
      <label>已发送副本<select name="sentCopy" key={provider?.id ?? 'custom'} defaultValue={provider?.sentCopy ?? 'append'}><option value="append">由客户端保存（一般邮箱）</option><option value="server">由服务商保存（Gmail / Outlook 等）</option></select></label>
      <label>账号代理（选填）<input name="proxy" placeholder="socks5://127.0.0.1:1080 或 http://127.0.0.1:7890" /></label>
      {(error || add.error) && <p className="error" role="alert">{error || add.error?.message}</p>}
      <div className="form-footer"><span className="hint">连接验证通过后保存，凭据加密存储。</span><Button type="submit" variant="primary" disabled={add.isPending || provider?.requiresOAuth}>{provider?.requiresOAuth ? '等待 OAuth 支持' : add.isPending ? '正在验证连接…' : '连接邮箱'}</Button></div>
    </form>
  </Modal>;
}
