import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { version } from '../package.json';
import type { BuildInfo } from '../packages/shared/src/index';

export function getBuildInfo(): BuildInfo {
  const supplied = process.env.MAIL_BUILD_REVISION?.trim();
  if (supplied && !/^[a-f\d]{40}$/i.test(supplied)) throw new Error('MAIL_BUILD_REVISION 必须是完整的 40 位 Git 提交号');
  let revision: string | null = supplied || null;
  let localChanges: boolean | null = null;
  if (!supplied) {
    try {
      const options = { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' as const, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
      revision = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
      localChanges = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).trim();
    } catch { /* Source archives and Docker builds can supply their revision explicitly. */ }
  }
  return { version, revision, localChanges, builtAt: new Date().toISOString() };
}
