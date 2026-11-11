import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OAuthClientInfo, OAuthClientSettings, OAuthProgress, OAuthProvider, OAuthStarted } from '@mail/shared';
import { api, json } from '../api';
import { Button, Modal } from './ui';

export function OAuthClientFields({ provider, source, onSource, saved, clients }: { provider: OAuthProvider; source: string; onSource: (source: string) => void; saved?: OAuthClientInfo; clients?: OAuthClientSettings }) {
  const global = clients?.[provider].custom;
  const preset = source === 'preset' || (source === 'automatic' && !global) || (source === 'saved' && saved?.source === 'preset');
  return <div className="oauth-client-fields">
    <label>OAuth 客户端<select name="oauthClientSource" value={source} onChange={event => onSource(event.target.value)}>
      {saved && <option value="saved">此邮箱已保存的客户端</option>}
      <option value="automatic">服务商默认（{global ? '已配置自己的客户端' : 'Thunderbird 预置值'}）</option>
      <option value="preset" disabled={clients && !clients[provider].presetAvailable}>Thunderbird 预置值</option>
      {global && <option value="global">服务商自定义客户端</option>}
      <option value="custom">仅此邮箱使用自己的客户端</option>
    </select></label>
    {source === 'custom' && <div className="form-grid"><label>Client ID<input name="oauthClientId" autoComplete="off" /></label>
      {provider === 'google' && <label>Client secret<input name="oauthClientSecret" type="password" autoComplete="new-password" /></label>}</div>}
    <div className="provider-note">{preset ? <p>即将使用 Thunderbird 的公开客户端。授权页会显示 <strong>Mozilla Thunderbird</strong>，邮件由本应用直接收发。预置值可能失效，也可能被组织禁用；你可以改用自己的客户端。</p>
      : <p>使用自己的桌面客户端。客户端设置会随本次授权保存在此邮箱中；更改服务商默认值后，已有邮箱需要重新授权。</p>}
      <a href={`/api/oauth/docs/${provider}`} target="_blank" rel="noreferrer">注册自己的 {provider === 'google' ? 'Google' : 'Microsoft'} 客户端 ↗</a>
    </div>
  </div>;
}

export function OAuthAuthorization({ session, onSaved, onCancel, onBusy }: { session: OAuthStarted; onSaved: (id: string) => void; onCancel: () => void; onBusy: (busy: boolean) => void }) {
  const [url, setUrl] = useState('');
  const query = useQueryClient();
  const progress = useQuery({ queryKey: ['oauth-session', session.id], queryFn: () => api<OAuthProgress>(`/oauth/sessions/${session.id}`), initialData: session,
    retry: false, refetchInterval: query => ['waiting', 'exchanging', 'saving'].includes(query.state.data?.status ?? '') && !query.state.error ? 1000 : false });
  const paste = useMutation({ mutationFn: () => api<OAuthProgress>(`/oauth/sessions/${session.id}/callback`, json('POST', { url: url.trim() })),
    onSuccess: result => { setUrl(''); query.setQueryData(['oauth-session', session.id], result); } });
  const finish = useMutation({ mutationFn: () => api<OAuthProgress>(`/oauth/sessions/${session.id}/complete`, json('POST', {})),
    onSuccess: result => { if (result.accountId) onSaved(result.accountId); } });
  const status = progress.data.status;
  useEffect(() => { onBusy(finish.isPending); }, [finish.isPending, onBusy]);
  return <div className="oauth-authorization">
    <p role="status">{status === 'ready' ? '已取得邮箱授权，点击完成连接验证收发信并保存。' : status === 'error' ? '本次授权未完成。' : '请在服务商页面登录并同意邮件权限，然后返回这里。'}</p>
    {status === 'waiting' && <>
      <a className="button button-primary" href={session.authorizationUrl} target="_blank" rel="noreferrer">打开服务商授权页 ↗</a>
      <details className="advanced"><summary>浏览器在另一台设备，或无法自动回调</summary>
        <p className="hint">授权后浏览器可能显示“无法访问此网站”。这是因为回调指向本机。请复制地址栏的完整网址并粘贴在下面；不要分享这个网址。Docker 或 NAS 不需要额外开放回调端口。</p>
        <form onSubmit={event => { event.preventDefault(); paste.mutate(); }}><label>完整回调网址<textarea value={url} onChange={event => setUrl(event.target.value)} placeholder={`${session.redirectUri}?code=…&state=…`} autoComplete="off" /></label>
          <Button type="submit" disabled={!url.trim() || paste.isPending}>{paste.isPending ? '正在处理…' : '提交回调网址'}</Button></form>
      </details>
    </>}
    {(progress.error || progress.data.error || paste.error || finish.error) && <p className="error" role="alert">{progress.error?.message || progress.data.error || paste.error?.message || finish.error?.message}</p>}
    <p className="hint">本次授权有效至 {new Date(session.expiresAt).toLocaleTimeString()}。令牌加密保存在本机，不会显示在网页中。</p>
    <div className="form-footer"><Button onClick={onCancel} disabled={finish.isPending}>返回设置</Button>
      <Button variant="primary" disabled={status !== 'ready' || finish.isPending} onClick={() => finish.mutate()}>{finish.isPending ? '正在验证收发信…' : '完成连接'}</Button></div>
  </div>;
}

export function OAuthSettings({ onClose }: { onClose: () => void }) {
  const query = useQueryClient();
  const clients = useQuery({ queryKey: ['oauth-clients'], queryFn: () => api<OAuthClientSettings>('/oauth/clients') });
  const [saved, setSaved] = useState('');
  const save = useMutation({ mutationFn: ({ provider, data }: { provider: OAuthProvider; data: { clientId: string; clientSecret?: string } | null }) => api<OAuthClientSettings>(`/oauth/clients/${provider}`, json('PUT', data)),
    onSuccess: (data, input) => { query.setQueryData(['oauth-clients'], data); setSaved(`${input.provider === 'google' ? 'Google' : 'Microsoft'} 客户端设置已保存。已有邮箱请到邮箱设置重新授权。`); } });
  function submit(event: FormEvent<HTMLFormElement>, provider: OAuthProvider) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    save.mutate({ provider, data: { clientId: String(form.get('clientId') ?? '').trim(), clientSecret: String(form.get('clientSecret') ?? '') || undefined } });
  }
  return <Modal title="OAuth 客户端设置" description="按服务商设置默认客户端。也可以在连接邮箱时单独覆盖。" onClose={() => { if (!save.isPending) onClose(); }}>
    {!clients.data ? <p>{clients.error?.message ?? '正在读取…'}</p> : (['google', 'microsoft'] as const).map(provider => <form className="oauth-settings-form" key={`${provider}:${clients.data[provider].custom?.clientId ?? ''}`} onSubmit={event => submit(event, provider)}>
      <h3>{provider === 'google' ? 'Google' : 'Microsoft'}</h3>
      <fieldset className="form-fields" disabled={save.isPending}>
        <label>Client ID<input name="clientId" required defaultValue={clients.data![provider].custom?.clientId} autoComplete="off" /></label>
        {provider === 'google' && <label>Client secret<input name="clientSecret" type="password" required={!clients.data[provider].custom?.hasSecret} placeholder={clients.data[provider].custom?.hasSecret ? '已保存，留空保留（更换 ID 时须重填）' : ''} autoComplete="new-password" /></label>}
        {provider === 'microsoft' && <p className="hint">公共桌面客户端，不需要 secret。请登记回调地址 http://localhost。</p>}
        <a href={`/api/oauth/docs/${provider}`} target="_blank" rel="noreferrer">查看注册教程 ↗</a>
        <div className="form-footer"><Button type="button" disabled={!clients.data[provider].custom} onClick={() => save.mutate({ provider, data: null })}>恢复预置值</Button><Button type="submit" variant="primary">保存</Button></div>
      </fieldset>
    </form>)}
    {save.error && <p className="error" role="alert">{save.error.message}</p>}{saved && <p role="status">{saved}</p>}
  </Modal>;
}
