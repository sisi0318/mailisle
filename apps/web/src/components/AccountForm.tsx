import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountSchema, accountUpdateSchema, detectProvider, providerPresets, type AccountInput, type AccountSettings, type AccountUpdate, type AutoConfig } from '@mail/shared';
import { api, json } from '../api';
import { describeIssues } from '../format';
import { Button, Modal } from './ui';
import { oauthStartSchema, type OAuthStarted, type OAuthStart, type OAuthClientSettings } from '@mail/shared';
import { OAuthAuthorization, OAuthClientFields } from './OAuth';

const labels = {
  name: '显示名称', email: '邮箱地址', proxy: '代理地址', sentCopy: '已发送副本',
  'imap.host': 'IMAP 服务器', 'imap.port': 'IMAP 端口', 'imap.security': 'IMAP 加密方式', 'imap.user': 'IMAP 登录名', 'imap.password': '密码',
  'smtp.host': 'SMTP 服务器', 'smtp.port': 'SMTP 端口', 'smtp.security': 'SMTP 加密方式', 'smtp.user': 'SMTP 登录名', 'smtp.password': '发信密码',
};

export function AccountForm({ accountId, onClose, onSaved }: { accountId?: string; onClose: () => void; onSaved?: (id: string) => void }) {
  const settings = useQuery({ queryKey: ['account-settings', accountId], queryFn: () => api<AccountSettings>(`/accounts/${accountId}`), enabled: !!accountId, staleTime: Infinity, refetchOnWindowFocus: false });
  if (accountId && !settings.data) return <Modal title="邮箱设置" onClose={onClose}>
    {settings.error ? <p role="alert" className="error">{settings.error.message}</p> : <p className="loading">正在读取设置…</p>}
  </Modal>;
  return <AccountEditor key={accountId ?? 'new'} accountId={accountId} settings={settings.data} onClose={onClose} onSaved={onSaved} />;
}

function AccountEditor({ accountId, settings, onClose, onSaved }: { accountId?: string; settings?: AccountSettings; onClose: () => void; onSaved?: (id: string) => void }) {
  const query = useQueryClient();
  const [error, setError] = useState('');
  const [email, setEmail] = useState(settings?.email ?? '');
  const [providerId, setProviderId] = useState(settings ? 'custom' : 'auto');
  const [serversOpen, setServersOpen] = useState<boolean | null>(settings ? true : null);
  const [discovered, setDiscovered] = useState<AutoConfig | null>(null);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const [clearProxy, setClearProxy] = useState(false);
  const [authMode, setAuthMode] = useState(settings?.oauth ? 'oauth' : settings ? 'password' : 'auto');
  const [clientSource, setClientSource] = useState(settings?.oauth ? 'saved' : 'automatic');
  const [authorization, setAuthorization] = useState<OAuthStarted | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const settingsOnly = useRef(false);
  const detected = detectProvider(email);
  const provider = providerId === 'auto' ? detected : providerPresets.find(item => item.id === providerId);
  const preset = providerId === 'discovered' ? discovered : provider;
  const providerHints = provider ?? (providerId === 'discovered' ? providerPresets.find(item => item.imap.host === discovered?.imap.host && item.smtp.host === discovered?.smtp.host) : undefined);
  const oauthProvider = provider?.id === 'gmail' || (providerId === 'discovered' && discovered?.imap.host === 'imap.gmail.com') ? 'google'
    : ['outlook', 'microsoft365'].includes(provider?.id ?? '') || (providerId === 'discovered' && discovered?.imap.host === 'outlook.office365.com') ? 'microsoft' : settings?.oauth?.provider;
  const useOAuth = !!oauthProvider && (authMode !== 'password' || !!preset?.requiresOAuth);
  const blocked = !!preset?.requiresOAuth && !oauthProvider;
  const clients = useQuery({ queryKey: ['oauth-clients'], queryFn: () => api<OAuthClientSettings>('/oauth/clients'), enabled: useOAuth });
  const start = useMutation({ mutationFn: (input: OAuthStart) => api<OAuthStarted>('/oauth/start', json('POST', input)), onSuccess: setAuthorization });
  useEffect(() => () => { if (authorization) void api(`/oauth/sessions/${authorization.id}`, json('DELETE', {})).catch(() => {}); }, [authorization]);
  function saved(id: string) { query.removeQueries({ queryKey: ['account-settings', accountId] }); void query.invalidateQueries(); onSaved?.(id); onClose(); }
  const save = useMutation({ mutationFn: (input: AccountInput | AccountUpdate) => api<{ id?: string }>(accountId ? `/accounts/${accountId}` : '/accounts', json(accountId ? 'PUT' : 'POST', input)),
    onSuccess: result => { const id = accountId ?? result.id; if (id) saved(id); } });
  const discover = useMutation({ mutationFn: (address: string) => api<{ config: AutoConfig | null }>('/autoconfig', json('POST', { email: address.trim() })),
    onSuccess: ({ config }, address) => {
      if (email.trim().toLowerCase() !== address.trim().toLowerCase()) return;
      if (!config) { setError('没有找到支持加密连接的 IMAP/SMTP 配置，请手动填写。'); return; }
      setDiscovered(config); setDiscoveryVersion(version => version + 1); setProviderId('discovered'); setServersOpen(true); setError(''); save.reset();
    } });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const password = String(form.get('password') ?? '');
    const server = (protocol: 'imap' | 'smtp') => ({ host: value(`${protocol}Host`), port: Number(value(`${protocol}Port`)), security: value(`${protocol}Security`),
      user: value(`${protocol}User`) || value('email'), password: String(form.get(`${protocol}Password`) || password) || (accountId ? undefined : '') });
    const account = { name: value('name') || preset?.name || value('email'), email: value('email'),
      imap: server('imap'), smtp: server('smtp'), proxy: clearProxy ? '' : value('proxy') || undefined, sentCopy: value('sentCopy') };
    const onlySave = settingsOnly.current;
    settingsOnly.current = false;
    if (useOAuth && oauthProvider && !onlySave) {
      const source = clientSource === 'automatic' ? clients.data?.[oauthProvider].custom ? 'global' : 'preset' : clientSource;
      const parsed = oauthStartSchema.safeParse({ account, accountId, provider: oauthProvider,
        client: { source, ...(source === 'custom' ? { clientId: value('oauthClientId'), clientSecret: String(form.get('oauthClientSecret') ?? '') || undefined } : {}) } });
      if (!parsed.success) { setServersOpen(true); setError(describeIssues(parsed.error.issues, labels)); return; }
      setError(''); start.mutate(parsed.data); return;
    }
    const parsed = (accountId ? accountUpdateSchema : accountSchema).safeParse(account);
    if (!parsed.success) { setServersOpen(true); setError(describeIssues(parsed.error.issues, labels)); return; }
    setError(''); save.mutate(parsed.data);
  }
  const presetKey = `${providerId}:${preset?.name ?? ''}:${providerId === 'discovered' ? discoveryVersion : 0}`;
  const proxyFields = <>
    <label>代理（选填）<input name="proxy" disabled={clearProxy} placeholder={settings?.proxyDisplay ? `留空保留现有代理 ${settings.proxyDisplay}` : 'socks5://127.0.0.1:1080 或 http://127.0.0.1:7890'} />
      {oauthProvider && <span className="hint">主机无法直连 {oauthProvider === 'google' ? 'Google' : 'Microsoft'} 时填写，收发信和换取令牌都会走它。授权页由浏览器打开，浏览器也要能访问。</span>}</label>
    {settings?.proxyDisplay && <label className="checkbox-label"><input type="checkbox" checked={clearProxy} onChange={event => setClearProxy(event.target.checked)} />移除现有代理</label>}
  </>;
  return <Modal title={accountId ? '邮箱设置' : '连接邮箱'} description={accountId ? '更换收信服务器或登录名会重新同步本地邮件索引，草稿保留。' : '通过 IMAP 和 SMTP 连接，邮件保存在运行信屿的主机上。'} onClose={() => { if (!save.isPending && !start.isPending && !authorizing) onClose(); }} wide>
    {authorization && <OAuthAuthorization session={authorization} onSaved={saved} onBusy={setAuthorizing} onCancel={() => { setAuthorization(null); start.reset(); }} />}
    <form onSubmit={submit} className="account-form" noValidate style={authorization ? { display: 'none' } : undefined}><fieldset className="form-fields" disabled={save.isPending || start.isPending}>
      <div className="form-grid"><label>邮箱地址<input name="email" type="email" required autoFocus value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label><label>显示名称（选填）<input name="name" defaultValue={settings?.name} placeholder={preset?.name ?? '例如：工作邮箱'} /></label></div>
      <label>邮箱服务商<select value={providerId} onChange={event => { setProviderId(event.target.value); setServersOpen(null); setError(''); save.reset(); setAuthMode(settings?.oauth ? 'oauth' : 'auto'); setClientSource('automatic'); }}>
        <option value="auto">自动识别{detected ? `：${detected.name}` : ''}</option>{providerPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        {discovered && <option value="discovered">在线配置：{discovered.name}</option>}<option value="custom">其他（手动填写服务器）</option>
      </select></label>
      <div className="discovery-row"><Button type="button" onClick={() => discover.mutate(email)} disabled={!email || discover.isPending}>{discover.isPending ? '正在查询…' : '在线查找服务器'}</Button><span className="hint">只向 Thunderbird 配置库查询邮箱域名。</span></div>
      {providerHints && <div className="provider-note" role="status"><strong>{providerHints.name}</strong><p>{providerHints.hint} <a href={providerHints.helpUrl} target="_blank" rel="noreferrer">查看帮助 ↗</a></p></div>}
      {providerId === 'discovered' && discovered && <p className="provider-note">已从 ISPDB 填入配置，请核对下方服务器。{blocked && '此服务商的 OAuth 暂不支持。'}</p>}
      {oauthProvider === 'google' && !settings?.oauth && <label>登录方式<select value={useOAuth ? 'oauth' : 'password'} onChange={event => setAuthMode(event.target.value)}><option value="oauth">Google OAuth 登录</option><option value="password">应用专用密码</option></select></label>}
      {useOAuth && oauthProvider ? <OAuthClientFields provider={oauthProvider} source={clientSource} onSource={setClientSource} saved={settings?.oauth?.client} clients={clients.data} />
        : !blocked && <label>{providerHints?.passwordLabel ?? '密码或授权码'}{accountId && '（留空不改）'}<input name="password" type="password" autoComplete="new-password" required={!accountId} placeholder={accountId ? '填写后同时更新收发信密码，发信可在下方另填' : ''} /></label>}
      {/* Google and Microsoft are often only reachable through a proxy, so for them the field is not tucked away below. */}
      {oauthProvider && proxyFields}
      <details className="advanced" open={serversOpen ?? !preset}>
        <summary onClick={event => { event.preventDefault(); setServersOpen(!(serversOpen ?? !preset)); }}>服务器与高级设置{preset && <span>已按 {preset.name} 填好</span>}</summary>
        <div className="form-grid" key={presetKey}>{(['imap', 'smtp'] as const).map(protocol => {
          const server = preset?.[protocol] ?? settings?.[protocol];
          const user = providerId === 'discovered' ? discovered?.[protocol].user : !preset ? settings?.[protocol].user : '';
          return <fieldset key={protocol}><legend>{protocol === 'imap' ? '收信（IMAP）' : '发信（SMTP）'}</legend>
            <label>服务器<input name={`${protocol}Host`} required defaultValue={server?.host ?? ''} placeholder={`${protocol}.example.com`} /></label>
            <div className="server-options"><label>端口<input name={`${protocol}Port`} type="number" min={1} max={65535} required defaultValue={server?.port ?? (protocol === 'imap' ? 993 : 465)} /></label><label>加密<select name={`${protocol}Security`} defaultValue={server?.security ?? 'tls'}><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="plain">不加密（仅本机）</option></select></label></div>
            <label>登录名（选填）<input name={`${protocol}User`} defaultValue={user} placeholder="默认用邮箱地址" /></label>
            {protocol === 'smtp' && !useOAuth && <label>独立发信密码（选填）<input name="smtpPassword" type="password" autoComplete="new-password" placeholder={accountId ? '留空保留，或使用上面新填写的密码' : '默认与上面相同'} /></label>}
          </fieldset>;
        })}</div>
        <label>已发送的邮件<select name="sentCopy" key={presetKey} defaultValue={preset?.sentCopy ?? settings?.sentCopy ?? 'append'}><option value="append">由本应用存入“已发送”（多数邮箱）</option><option value="server">服务商会自动保存（Gmail、Outlook）</option></select></label>
        {!oauthProvider && proxyFields}
      </details>
    </fieldset>
    {(error || save.error || discover.error || start.error || clients.error) && <p className="error" role="alert">{error || save.error?.message || discover.error?.message || start.error?.message || clients.error?.message}</p>}
    <div className="form-footer"><span className="hint">验证收发信后保存，凭据加密存储。</span>
      {/* Not a submit button: Enter in a field would pick the first one, and saving would drop a client ID typed for re-authorisation. */}
      {settings?.oauth && <Button type="button" disabled={save.isPending || start.isPending} onClick={event => { settingsOnly.current = true; event.currentTarget.form?.requestSubmit(); }}>保存设置</Button>}
      <Button type="submit" variant="primary" disabled={save.isPending || start.isPending || blocked || (useOAuth && !clients.data)}>{blocked ? '暂不支持' : save.isPending || start.isPending ? '正在处理…' : useOAuth ? settings?.oauth ? '重新授权' : '开始 OAuth 授权' : accountId ? '保存设置' : '连接'}</Button></div>
    </form>
  </Modal>;
}
