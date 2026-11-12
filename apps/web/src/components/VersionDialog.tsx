import { useMutation, useQuery } from '@tanstack/react-query';
import { PROJECT_URL, type BuildInfo, type UpdateCheck } from '@mail/shared';
import { api, json } from '../api';
import { frontendBuild } from '../version';
import { Button, Modal } from './ui';

const statuses: Record<UpdateCheck['status'], string> = {
  available: '发现可用更新', current: '仓库暂无新提交', 'local-ahead': '本地构建领先于仓库',
  diverged: '本地与仓库有不同改动，请手动检查', unknown: '未记录构建提交，暂时无法判断',
};
export function VersionDialog({ onClose }: { onClose: () => void }) {
  const version = useQuery({ queryKey: ['version'], queryFn: () => api<BuildInfo>('/version'), retry: false });
  const check = useMutation({ mutationFn: () => api<UpdateCheck>('/updates/check', json('POST', {})) });
  const current = version.data ?? frontendBuild;
  const mismatch = !!version.data && (current.version !== frontendBuild.version || current.revision !== frontendBuild.revision);
  return <Modal title="版本与更新" description="检查项目 main 分支的新提交。" onClose={onClose}>
    <dl className="version-details">
      <div><dt>当前版本</dt><dd>v{current.version}</dd></div>
      <div><dt>构建提交</dt><dd>{current.revision?.slice(0, 7) ?? '未记录'}</dd></div>
      <div><dt>构建时间</dt><dd>{new Date(current.builtAt).toLocaleString()}</dd></div>
    </dl>
    {current.localChanges && <p className="hint">此构建包含未提交的本地修改。</p>}
    {mismatch && <p className="error" role="alert">页面与服务版本不同，请更新构建后刷新页面。</p>}
    {version.error && <p className="error" role="alert">{version.error.message}</p>}
    {check.error && <p className="error" role="alert">{check.error.message}</p>}
    {check.data && <div className="update-result" role="status">
      <strong>{statuses[check.data.status]}</strong>
      <p>{check.data.latest.title}</p>
      <p className="hint">最新提交 {check.data.latest.revision.slice(0, 7)} · {new Date(check.data.latest.date).toLocaleString()}</p>
      <a href={check.data.latest.url} target="_blank" rel="noreferrer">查看这次提交 ↗</a>
    </div>}
    <p className="hint">更新需拉取代码、重新构建并重启。此处只检查，不自动安装。</p>
    <div className="form-footer"><a href={PROJECT_URL} target="_blank" rel="noreferrer">打开项目仓库 ↗</a>
      <Button variant="primary" disabled={check.isPending || !version.data} onClick={() => check.mutate()}>{check.isPending ? '正在检查…' : '检查更新'}</Button></div>
  </Modal>;
}
