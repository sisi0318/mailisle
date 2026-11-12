import { request } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { z } from 'zod';
import { UserError } from '@mail/core';
import { PROJECT_URL, type BuildInfo, type UpdateCheck } from '@mail/shared';
import { getBuildInfo } from '../../../scripts/build-info';

declare const __MAILISLE_BUILD__: BuildInfo;
// Production uses the compiled identity, even if newer source has since been pulled into the checkout.
export const serverBuild = typeof __MAILISLE_BUILD__ === 'undefined' ? getBuildInfo() : __MAILISLE_BUILD__;
const api = 'https://api.github.com/repos/sisi0318/mailisle';
const commitSchema = z.object({ sha: z.string().regex(/^[a-f\d]{40}$/i), commit: z.object({ message: z.string(), committer: z.object({ date: z.iso.datetime() }) }) });
const comparisonSchema = z.object({ status: z.enum(['ahead', 'behind', 'identical', 'diverged']) });

export class UpdateChecker {
  private read: (url: string) => Promise<unknown>;
  constructor(readonly current: BuildInfo = serverBuild, read?: (url: string) => Promise<unknown>, proxy: () => string | undefined = () => undefined) {
    this.read = read ?? (url => readGithub(url, proxy()));
  }
  async check(): Promise<UpdateCheck> {
    const parsed = commitSchema.safeParse(await this.read(`${api}/commits/main`));
    if (!parsed.success) throw new UserError('更新信息无法识别，请稍后重试', 502);
    const commit = parsed.data;
    const latest = { revision: commit.sha, title: commit.commit.message.split('\n')[0], date: commit.commit.committer.date, url: `${PROJECT_URL}/commit/${commit.sha}` };
    let status: UpdateCheck['status'] = 'unknown';
    if (this.current.revision === latest.revision) status = 'current';
    else if (this.current.revision) {
      const compared = comparisonSchema.safeParse(await this.read(`${api}/compare/${this.current.revision}...${latest.revision}?per_page=1`));
      if (!compared.success) throw new UserError('无法比较当前构建，请查看仓库', 502);
      status = ({ ahead: 'available', behind: 'local-ahead', identical: 'current', diverged: 'diverged' } as const)[compared.data.status];
    }
    return { status, current: this.current, latest, checkedAt: new Date().toISOString() };
  }
}

async function readGithub(url: string, proxy?: string): Promise<unknown> {
  const agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const req = request(url, { agent, signal: AbortSignal.timeout(10_000), headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'MailIsle-UpdateCheck', 'X-GitHub-Api-Version': '2026-03-10',
      } }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          const message = response.statusCode === 403 || response.statusCode === 429 ? 'GitHub 暂时限制了请求，请稍后重试'
            : response.statusCode === 404 ? '找不到对应的仓库提交，请查看仓库' : '暂时无法获取更新信息，请稍后重试';
          reject(new UserError(message, 502)); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) response.destroy(new Error('response too large'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new UserError('读取更新信息失败，请稍后重试', 502)));
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new UserError('更新信息无法识别，请稍后重试', 502)); }
        });
      });
      req.on('error', () => reject(new UserError('无法连接 GitHub，请检查网络或代理后重试', 502)));
      req.end();
    });
  } finally { agent?.destroy(); }
}
