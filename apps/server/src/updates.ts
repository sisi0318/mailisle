import { request } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { z } from 'zod';
import { UserError, publicError } from '@mail/core';
import type { MailStore } from '@mail/db';
import { defaultUpdateSettings, PROJECT_URL, type BuildInfo, type UpdateChannel, type UpdateCheck, type UpdateSettings, type UpdateState } from '@mail/shared';
import { getBuildInfo } from '../../../scripts/build-info';

declare const __MAILISLE_BUILD__: BuildInfo;
// Production uses the compiled identity, even if newer source has since been pulled into the checkout.
export const serverBuild = typeof __MAILISLE_BUILD__ === 'undefined' ? getBuildInfo() : __MAILISLE_BUILD__;
const api = 'https://api.github.com/repos/sisi0318/mailisle';
const commitSchema = z.object({ sha: z.string().regex(/^[a-f\d]{40}$/i), commit: z.object({ message: z.string(), committer: z.object({ date: z.iso.datetime() }) }) });
const comparisonSchema = z.object({ status: z.enum(['ahead', 'behind', 'identical', 'diverged']) });
const releasesSchema = z.array(z.object({ tag_name: z.string(), name: z.string().nullable(), draft: z.boolean(), prerelease: z.boolean(), published_at: z.iso.datetime().nullable() }));

export class UpdateChecker {
  private read: (url: string, useGlobalProxy: boolean) => Promise<unknown>;
  constructor(readonly current: BuildInfo = serverBuild, read?: (url: string, proxy?: string) => Promise<unknown>, proxy: () => string | undefined = () => undefined) {
    this.read = (url, useGlobalProxy) => (read ?? readGithub)(url, useGlobalProxy ? proxy() : undefined);
  }
  async check(channel: UpdateChannel = 'source', useGlobalProxy = true): Promise<UpdateCheck> {
    let release: { tag_name: string; name: string | null; published_at: string | null } | undefined;
    if (channel !== 'source') {
      for (let page = 1; ; page++) {
        const parsed = releasesSchema.safeParse(await this.read(`${api}/releases?per_page=100&page=${page}`, useGlobalProxy));
        if (!parsed.success) throw new UserError('发布信息无法识别，请稍后重试', 502);
        release = parsed.data.find(item => !item.draft && item.prerelease === (channel === 'ci'));
        if (release || parsed.data.length < 100) break;
      }
      if (!release) return { channel, status: 'unpublished', current: this.current, latest: null, checkedAt: new Date().toISOString() };
    }
    const parsed = commitSchema.safeParse(await this.read(`${api}/commits/${release ? encodeURIComponent(release.tag_name) : 'main'}`, useGlobalProxy));
    if (!parsed.success) throw new UserError('更新信息无法识别，请稍后重试', 502);
    const commit = parsed.data;
    const latest = { revision: commit.sha, title: release?.name || release?.tag_name || commit.commit.message.split('\n')[0], date: release?.published_at ?? commit.commit.committer.date,
      url: release ? `${PROJECT_URL}/releases/tag/${encodeURIComponent(release.tag_name)}` : `${PROJECT_URL}/commit/${commit.sha}`, ...(release ? { tag: release.tag_name } : {}) };
    let status: UpdateCheck['status'] = 'unknown';
    if (this.current.revision === latest.revision) status = 'current';
    else if (this.current.revision) {
      const compared = comparisonSchema.safeParse(await this.read(`${api}/compare/${this.current.revision}...${latest.revision}?per_page=1`, useGlobalProxy));
      if (!compared.success) throw new UserError('无法比较当前构建，请查看仓库', 502);
      status = ({ ahead: 'available', behind: 'local-ahead', identical: 'current', diverged: 'diverged' } as const)[compared.data.status];
    }
    return { status, channel, current: this.current, latest, checkedAt: new Date().toISOString() };
  }
}

export class UpdateManager {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<UpdateCheck>;
  constructor(private store: MailStore, readonly checker: UpdateChecker, private notify: () => void = () => {}) {}
  settings(): UpdateSettings {
    const saved = this.store.getSetting('update-settings');
    return saved ? JSON.parse(saved) : { ...defaultUpdateSettings };
  }
  state(): UpdateState {
    const saved = this.store.getSetting('update-state');
    return saved ? JSON.parse(saved) : { checkedAt: null, result: null, error: null };
  }
  save(settings: UpdateSettings) {
    const previous = this.settings();
    this.store.setSetting('update-settings', JSON.stringify(settings));
    if (previous.channel !== settings.channel || previous.useGlobalProxy !== settings.useGlobalProxy) this.store.setSetting('update-state', JSON.stringify({ checkedAt: null, result: null, error: null }));
    this.notify();
    return settings;
  }
  start() {
    this.stop();
    void this.automatic('timer');
    this.timer = setInterval(() => { void this.automatic('timer'); }, 60_000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  async automatic(trigger: 'timer' | 'open') {
    const settings = this.settings();
    if (!settings.enabled) return this.state();
    if (settings.frequency === 'on-open' ? trigger !== 'open' : !this.due(settings)) return this.state();
    try { await this.check(); } catch { /* Automatic errors are shown in update settings, without interrupting mail. */ }
    return this.state();
  }
  check(): Promise<UpdateCheck> {
    if (this.running) return this.running;
    const settings = this.settings();
    this.running = this.checker.check(settings.channel, settings.useGlobalProxy).then(result => {
      this.store.setSetting('update-state', JSON.stringify({ checkedAt: result.checkedAt, result, error: null }));
      return result;
    }, error => {
      this.store.setSetting('update-state', JSON.stringify({ checkedAt: new Date().toISOString(), result: null, error: publicError(error) }));
      throw error;
    }).finally(() => { this.running = undefined; this.notify(); });
    return this.running;
  }
  private due(settings: UpdateSettings) {
    const checkedAt = this.state().checkedAt;
    const interval = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000, 'on-open': 0 }[settings.frequency];
    return !checkedAt || Date.now() - Date.parse(checkedAt) >= interval;
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
