import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, FileText, Library, Mail, Scale } from 'lucide-react';
import { PROJECT_URL } from '@mail/shared';
import { frontendBuild } from '../version';
import { Button } from './ui';

export type AboutPage = 'about' | 'license' | 'components' | 'disclaimer';
type ComponentNotice = { name: string; version: string; license: string; author: string; homepage?: string; notice: string };
const featured = ['react', 'react-dom', '@tanstack/react-query', '@tiptap/react', '@radix-ui/react-dialog', 'lucide-react', 'hono', 'imapflow', 'nodemailer', 'postal-mime', 'better-sqlite3', 'drizzle-orm', 'dompurify', 'Thunderbird OAuth 配置摘录'];

export function About({ page, onNavigate, onUpdates }: { page: AboutPage; onNavigate: (page: AboutPage) => void; onUpdates: () => void }) {
  if (page === 'components') return <UpstreamComponents />;
  if (page === 'license') return <div className="legal-page">
    <p>信屿的原创代码采用 Apache-2.0。单独注明许可的文件、上游组件及第三方内容适用各自条款。</p>
    <a href="/legal/LICENSE.txt" download>下载项目许可全文</a>
    <LicenseText filename="LICENSE.txt" />
    <details className="legal-notice"><summary>项目署名声明（NOTICE）</summary><LicenseText filename="NOTICE.txt" /></details>
  </div>;
  if (page === 'disclaimer') return <div className="legal-page">
    <section><h4>独立项目</h4><p>信屿是独立开发的自部署邮件客户端，与 Google、Microsoft、腾讯、Mozilla、Thunderbird 等服务商或项目没有隶属、合作或背书关系。相关名称及商标归各自权利人所有。</p></section>
    <section><h4>邮箱与数据</h4><p>请只连接你有权访问的邮箱，并遵守邮件服务商的条款及适用法律。邮件、附件及其他内容的权利归原权利人所有，本项目的开源许可不授予对这些内容的额外权利。</p></section>
    <section><h4>软件与使用风险</h4><p>软件按现状提供。在适用法律允许的范围内，不对持续可用性、无错误或特定用途作保证。请妥善保管登录凭据、配置访问权限，并定期备份；同步、移动和删除等操作可能影响服务器上的邮件。</p></section>
    <section><h4>预置授权应用</h4><p>当前保留的 Thunderbird 公开 OAuth 配置用于兼容已有授权方式。上游建议其他应用注册自己的客户端；源码许可不等于获准使用第三方客户端或服务。建议在“设置 → 自定义授权应用”中配置自己的应用。</p>
      <a href="/legal/thunderbird.txt" target="_blank" rel="noreferrer">查看配置来源与使用说明 ↗</a></section>
    <section><h4>上游许可与责任</h4><p>第三方组件保持原有版权及许可。再分发时需遵守相应的署名、许可副本、修改说明或源码提供等要求；这些说明和清单不代替所需授权，也不代表所有使用或分发方式均已满足法律要求。</p></section>
    <section><h4>适用范围</h4><p>本说明不变更任何开源许可证，不限制许可证已授予的权利，也不排除法律规定不得免除的责任。具体权利和义务以适用法律及各组件原始许可为准。</p></section>
  </div>;
  return <div className="about-page">
    <div className="about-identity"><span className="about-icon"><Mail size={32} aria-hidden /></span><h4>信屿 MailIsle</h4><p>v{frontendBuild.version} · 自部署邮件客户端</p></div>
    <div className="about-links"><a className="button button-secondary" href={PROJECT_URL} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden />项目主页（GitHub）</a><Button onClick={onUpdates}>版本与更新</Button></div>
    <p className="about-repository">github.com/sisi0318/mailisle</p>
    <div className="settings-menu">
      <button onClick={() => onNavigate('license')}><Scale size={20} /><span><strong>开源许可</strong><small>Apache-2.0 与署名</small></span><ChevronRight size={17} /></button>
      <button onClick={() => onNavigate('components')}><Library size={20} /><span><strong>上游开源组件</strong></span><ChevronRight size={17} /></button>
      <button onClick={() => onNavigate('disclaimer')}><FileText size={20} /><span><strong>免责声明</strong><small>第三方权利与使用说明</small></span><ChevronRight size={17} /></button>
    </div>
  </div>;
}

function UpstreamComponents() {
  const [search, setSearch] = useState(''); const [limit, setLimit] = useState(20);
  const data = useQuery({ queryKey: ['legal-components'], queryFn: async () => {
    const response = await fetch('/legal/index.json');
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('许可资料暂不可用，请重新构建应用。');
    return response.json() as Promise<{ components: ComponentNotice[] }>;
  } });
  const components = [...(data.data?.components ?? [])].sort((a, b) => {
    const rank = (name: string) => { const index = featured.indexOf(name); return index < 0 ? featured.length : index; };
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'en');
  }).filter(item => `${item.name} ${item.license}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="legal-page">
    <p>感谢上游开源项目。本清单包含本次构建的生产依赖及其间接依赖，保留各自的版权和许可文件。</p>
    <a href="/legal/THIRD-PARTY-NOTICES.txt" download>下载全部组件声明</a>
    <label>查找组件<input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(20); }} placeholder="名称或许可证" /></label>
    {data.isPending ? <p role="status">正在读取…</p> : data.error ? <p role="alert" className="error">{data.error.message}</p> : <>
      <p className="hint">共 {components.length} 项</p>
      <div className="component-notices">{components.slice(0, limit).map(component => <ComponentLicense key={`${component.name}@${component.version}`} component={component} />)}</div>
      {components.length > limit && <Button onClick={() => setLimit(limit + 20)}>显示更多</Button>}
    </>}
  </div>;
}
function ComponentLicense({ component }: { component: ComponentNotice }) {
  const [open, setOpen] = useState(false);
  return <details className="legal-notice" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span><strong>{component.name}</strong><small>{component.version}</small></span><small>{component.license}</small></summary>
    {open && <div className="legal-component-body">
      {component.author && <p className="hint">{component.author}</p>}
      <div className="about-links">{component.homepage && <a href={component.homepage} target="_blank" rel="noreferrer">上游项目 ↗</a>}<a href={`/legal/${component.notice}`} download>下载许可声明</a></div>
      {component.notice === 'thunderbird.txt' && <a href="/legal/oauth-presets.ts.txt" download>下载本次构建的配置摘录</a>}
      <LicenseText filename={component.notice} />
    </div>}
  </details>;
}
function LicenseText({ filename }: { filename: string }) {
  const content = useQuery({ queryKey: ['legal-text', filename], queryFn: async () => {
    const response = await fetch(`/legal/${filename}`);
    if (!response.ok || !response.headers.get('content-type')?.includes('text/plain')) throw new Error('许可文件暂不可用，请重新构建应用。');
    return response.text();
  } });
  return content.isPending ? <p role="status">正在读取…</p> : content.error ? <p role="alert" className="error">{content.error.message}</p> : <pre className="license-text">{content.data}</pre>;
}
