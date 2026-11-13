import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Info, KeyRound, Network, RefreshCw } from 'lucide-react';
import type { GlobalProxySettings, OAuthClientSettings, OAuthProvider, UpdateSettings } from '@mail/shared';
import { api, json } from '../api';
import { Button, Modal } from './ui';
import { About, type AboutPage } from './About';

type Page = 'home' | 'proxy' | 'apps' | 'microsoft' | 'google' | 'updates' | AboutPage;
const titles: Record<Page, string> = { home: '设置', proxy: '网络代理', apps: '自定义授权应用', microsoft: 'Microsoft', google: 'Google', updates: '更新设置', about: '关于', license: '开源许可', components: '上游开源组件', disclaimer: '免责声明' };
export function GlobalSettings({ onClose, onUpdates }: { onClose: () => void; onUpdates: () => void }) {
  const query = useQueryClient();
  const [page, setPage] = useState<Page>('home');
  const heading = useRef<HTMLHeadingElement>(null);
  const [saved, setSaved] = useState<{ page: Page; text: string }>();
  const proxy = useQuery({ queryKey: ['global-proxy'], queryFn: () => api<GlobalProxySettings>('/settings/proxy') });
  const clients = useQuery({ queryKey: ['oauth-clients'], queryFn: () => api<OAuthClientSettings>('/oauth/clients') });
  const updates = useQuery({ queryKey: ['update-settings'], queryFn: () => api<UpdateSettings>('/settings/updates') });
  const [proxyInput, setProxyInput] = useState('');
  const [updateDraft, setUpdateDraft] = useState<UpdateSettings>();
  const updateValues = updateDraft ?? updates.data;
  const saveProxy = useMutation({ mutationFn: (value: string | null) => api<GlobalProxySettings>('/settings/proxy', json('PUT', { proxy: value })),
    onSuccess: data => { query.setQueryData(['global-proxy'], data); setProxyInput(''); setSaved({ page: 'proxy', text: data.configured ? '全局代理已保存。' : '全局代理已清除。' }); } });
  const saveClient = useMutation({ mutationFn: ({ provider, data }: { provider: OAuthProvider; data: { clientId: string; clientSecret?: string } | null }) => api<OAuthClientSettings>(`/oauth/clients/${provider}`, json('PUT', data)),
    onSuccess: (data, input) => { query.setQueryData(['oauth-clients'], data); setSaved({ page: input.provider, text: '设置已保存。已有邮箱需重新授权。' }); } });
  const saveUpdates = useMutation({ mutationFn: (settings: UpdateSettings) => api<UpdateSettings>('/settings/updates', json('PUT', settings)),
    onSuccess: data => { query.setQueryData(['update-settings'], data); void query.invalidateQueries({ queryKey: ['update-status'] }); setUpdateDraft(undefined); setSaved({ page: 'updates', text: '更新设置已保存。' }); } });
  const busy = saveProxy.isPending || saveClient.isPending || saveUpdates.isPending;
  const providerPage = page === 'google' || page === 'microsoft';
  const aboutChild = page === 'license' || page === 'components' || page === 'disclaimer';
  useEffect(() => { heading.current?.focus(); }, [page]);
  function navigate(next: Page) { setPage(next); saveProxy.reset(); saveClient.reset(); saveUpdates.reset(); }
  function submitClient(event: FormEvent<HTMLFormElement>, provider: OAuthProvider) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    saveClient.mutate({ provider, data: { clientId: String(data.get('clientId') ?? '').trim(), clientSecret: String(data.get('clientSecret') ?? '') || undefined } },
      { onSuccess: () => { const secret = form.elements.namedItem('clientSecret'); if (secret instanceof HTMLInputElement) secret.value = ''; } });
  }
  return <Modal title="设置" className="global-settings" onClose={() => { if (!busy) onClose(); }}>
    {page !== 'home' && <nav className="settings-breadcrumb" aria-label="设置导航">
      <button disabled={busy} onClick={() => navigate(providerPage ? 'apps' : aboutChild ? 'about' : 'home')} aria-label="返回上一级"><ArrowLeft size={16} /></button>
      <button disabled={busy} onClick={() => navigate('home')}>设置</button><ChevronRight size={12} aria-hidden />
      {providerPage && <><button disabled={busy} onClick={() => navigate('apps')}>自定义授权应用</button><ChevronRight size={12} aria-hidden /></>}
      {aboutChild && <><button onClick={() => navigate('about')}>关于</button><ChevronRight size={12} aria-hidden /></>}
      <span aria-current="page">{titles[page]}</span>
    </nav>}
    <h3 ref={heading} tabIndex={-1} className={`settings-heading ${page === 'home' ? 'sr-only' : ''}`}>{page === 'home' ? '选择设置类别' : titles[page]}</h3>
    {page === 'home' && <div className="settings-menu">
      <button onClick={() => navigate('proxy')}><Network size={21} /><span><strong>网络代理</strong><small>{proxy.data?.configured ? '已设置全局代理' : '未设置'}</small></span><ChevronRight size={17} /></button>
      <button onClick={() => navigate('apps')}><KeyRound size={21} /><span><strong>自定义授权应用</strong><small>Microsoft、Google 授权设置</small></span><ChevronRight size={17} /></button>
      <button onClick={() => navigate('updates')}><RefreshCw size={21} /><span><strong>更新设置</strong><small>检查频率、渠道与代理</small></span><ChevronRight size={17} /></button>
      <button onClick={() => navigate('about')}><Info size={21} /><span><strong>关于</strong><small>项目、开源许可与使用说明</small></span><ChevronRight size={17} /></button>
    </div>}
    {(page === 'about' || aboutChild) && <About page={page as AboutPage} onNavigate={navigate} onUpdates={onUpdates} />}
    {page === 'apps' && <><p className="settings-intro">设置默认授权应用，单个邮箱也可独立配置。</p><div className="settings-menu">
      {(['microsoft', 'google'] as const).map(provider => <button key={provider} onClick={() => navigate(provider)}>
        <span className="settings-provider-mark" aria-hidden>{provider === 'microsoft' ? 'MS' : 'G'}</span><span><strong>{titles[provider]}</strong><small>{clients.data?.[provider].custom ? '已配置自定义应用' : '使用预置授权应用'}</small></span><ChevronRight size={17} />
      </button>)}
    </div></>}
    <div hidden={page !== 'proxy'}><form className="settings-form" onSubmit={event => { event.preventDefault(); saveProxy.mutate(proxyInput.trim()); }}>
      <fieldset className="form-fields" disabled={busy}>
        <p className="hint">{proxy.isPending ? '正在读取…' : proxy.error ? proxy.error.message : proxy.data?.display ? `当前代理：${proxy.data.display}` : '未设置，默认直接连接。'}</p>
        <label>全局代理地址<input value={proxyInput} onChange={event => setProxyInput(event.target.value)} placeholder="HTTP 或 SOCKS5 代理地址" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        <p className="hint">供选择“继承全局”的邮箱使用。更新检查是否使用代理，可在更新设置中选择。</p>
        <div className="form-footer"><Button type="button" disabled={!proxy.data?.configured} onClick={() => saveProxy.mutate(null)}>清除代理</Button><Button type="submit" variant="primary" disabled={!proxyInput.trim()}>{saveProxy.isPending ? '正在应用…' : '保存代理'}</Button></div>
      </fieldset>
      {saveProxy.error && <p className="error" role="alert">{saveProxy.error.message}</p>}
    </form></div>
    {(['microsoft', 'google'] as const).map(provider => <div key={provider} hidden={page !== provider}>
      {!clients.data ? <p role="status">{clients.error?.message ?? '正在读取…'}</p> : <form className="settings-form" key={clients.data[provider].custom?.clientId ?? ''} onSubmit={event => submitClient(event, provider)}>
        <fieldset className="form-fields" disabled={busy}>
          <label>Client ID<input name="clientId" required defaultValue={clients.data[provider].custom?.clientId} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
          {provider === 'google' && <label>Client secret<input name="clientSecret" type="password" required={!clients.data[provider].custom?.hasSecret} placeholder={clients.data[provider].custom?.hasSecret ? '留空保留；更换 ID 时须重填' : ''} autoComplete="new-password" /></label>}
          {provider === 'microsoft' && <p className="hint">公共桌面客户端，无需 Client secret。回调地址请填 http://localhost。</p>}
          <a href={`/api/oauth/docs/${provider}`} target="_blank" rel="noreferrer">查看注册教程 ↗</a>
          <div className="form-footer"><Button type="button" disabled={!clients.data[provider].custom} onClick={() => saveClient.mutate({ provider, data: null })}>恢复预置值</Button><Button type="submit" variant="primary">{saveClient.isPending ? '正在保存…' : '保存'}</Button></div>
        </fieldset>
        {saveClient.error && <p className="error" role="alert">{saveClient.error.message}</p>}
      </form>}
    </div>)}
    <div hidden={page !== 'updates'}>{!updateValues ? <p role="status">{updates.error?.message ?? '正在读取…'}</p> : <form className="settings-form" onSubmit={event => { event.preventDefault(); saveUpdates.mutate(updateValues); }}>
      <fieldset className="form-fields" disabled={busy}>
        <label className="settings-switch"><span><strong>检查更新</strong><small>自动检查，不会自动安装</small></span><input type="checkbox" switch="" role="switch" checked={updateValues.enabled} onChange={event => setUpdateDraft({ ...updateValues, enabled: event.target.checked })} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={updateValues.useGlobalProxy} onChange={event => setUpdateDraft({ ...updateValues, useGlobalProxy: event.target.checked })} />使用全局代理</label>
        {updateValues.useGlobalProxy && <p className="hint">{proxy.data?.configured ? `当前代理：${proxy.data.display}` : '未设置全局代理，将直接连接。'}</p>}
        <label>检查频率<select disabled={!updateValues.enabled} value={updateValues.frequency} onChange={event => setUpdateDraft({ ...updateValues, frequency: event.target.value as UpdateSettings['frequency'] })}>
          <option value="hourly">每小时</option><option value="daily">每天</option><option value="weekly">每周</option><option value="on-open">每次打开网页</option>
        </select></label>
        <label>检查渠道<select value={updateValues.channel} onChange={event => setUpdateDraft({ ...updateValues, channel: event.target.value as UpdateSettings['channel'] })}>
          <option value="stable">正式版</option><option value="ci">CI 版</option><option value="source">源码提交</option>
        </select></label>
        {updateValues.channel !== 'stable' && <p className="hint">{updateValues.channel === 'ci' ? '检查 GitHub 预发布版本，可能不稳定。' : '检查 main 分支的最新提交。'}</p>}
        <div className="form-footer"><Button type="button" onClick={onUpdates}>查看版本与更新</Button><Button variant="primary" type="submit">{saveUpdates.isPending ? '正在保存…' : '保存设置'}</Button></div>
      </fieldset>
      {saveUpdates.error && <p className="error" role="alert">{saveUpdates.error.message}</p>}
    </form>}</div>
    {saved?.page === page && <p className="settings-saved" role="status">{saved.text}</p>}
  </Modal>;
}
