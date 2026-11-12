import { expect, it, vi } from 'vitest';
import { defaultUpdateSettings, type BuildInfo } from '@mail/shared';
import { UpdateChecker, UpdateManager } from './updates';
import { database } from '../../../tests/fixtures';

const old = 'a'.repeat(40); const latest = 'b'.repeat(40);
const current: BuildInfo = { version: '0.1.0', revision: old, builtAt: '2026-11-12T00:00:00.000Z', localChanges: false };
const remote = { sha: latest, commit: { message: '新增功能\n\n完整说明', committer: { date: '2026-11-12T01:00:00Z' } } };

it.each([['ahead', 'available'], ['behind', 'local-ahead'], ['identical', 'current'], ['diverged', 'diverged']] as const)('reports %s without confusing newer local builds with updates', async (status, expected) => {
  const calls: string[] = [];
  const check = new UpdateChecker(current, async url => { calls.push(url); return calls.length === 1 ? remote : { status }; });
  const result = await check.check();
  expect(result.status).toBe(expected); expect(result.latest!.title).toBe('新增功能');
  expect(calls[1]).toContain(`${old}...${latest}`); expect(result.latest!.url).toBe(`https://github.com/sisi0318/mailisle/commit/${latest}`);
});
it('recognizes the same commit without another request and keeps local modification information', async () => {
  let calls = 0;
  const result = await new UpdateChecker({ ...current, revision: latest, localChanges: true }, async () => { calls++; return remote; }).check();
  expect(result.status).toBe('current'); expect(calls).toBe(1); expect(result.current.localChanges).toBe(true);
});
it('does not claim to be current when a build has no recorded revision', async () => {
  expect((await new UpdateChecker({ ...current, revision: null }, async () => remote).check()).status).toBe('unknown');
});
it('does not report success after a network failure or malformed update data', async () => {
  await expect(new UpdateChecker(current, async () => { throw new Error('offline'); }).check()).rejects.toThrow('offline');
  await expect(new UpdateChecker(current, async () => ({ sha: 'invalid' })).check()).rejects.toThrow('无法识别');
});

it.each([['stable', 'v1.0'], ['ci', 'v1.1-beta']] as const)('selects the %s channel and resolves its tag, without following a draft', async (channel, tag) => {
  const urls: string[] = [];
  const checker = new UpdateChecker(current, async url => {
    urls.push(url);
    if (url.includes('/releases?')) return [
      { tag_name: 'draft', name: null, draft: true, prerelease: false, published_at: null },
      { tag_name: 'v1.1-beta', name: '预发布', draft: false, prerelease: true, published_at: '2026-11-12T00:00:00Z' },
      { tag_name: 'v1.0', name: '正式版', draft: false, prerelease: false, published_at: '2026-11-11T00:00:00Z' },
    ];
    return url.includes('/compare/') ? { status: 'ahead' } : remote;
  });
  const result = await checker.check(channel);
  expect(result).toMatchObject({ channel, status: 'available', latest: { tag, revision: latest } });
  expect(urls[1]).toContain(`/commits/${tag}`);
  expect(result.latest!.url).toContain(`/releases/tag/${tag}`);
});
it('reports unpublished channels explicitly and can bypass the global proxy', async () => {
  const proxies: (string | undefined)[] = [];
  const checker = new UpdateChecker(current, async (_url, proxy) => { proxies.push(proxy); return []; }, () => 'http://127.0.0.1:7890');
  expect(await checker.check('stable', false)).toMatchObject({ status: 'unpublished', latest: null });
  await checker.check('ci', true);
  expect(proxies).toEqual([undefined, 'http://127.0.0.1:7890']);
});
it.each([['hourly', 3_600_000], ['daily', 86_400_000], ['weekly', 604_800_000]] as const)('checks %s only when due, across restarts, and honors the master switch', async (frequency, interval) => {
  vi.useFakeTimers(); const store = database(); let calls = 0;
  const checker = new UpdateChecker({ ...current, revision: latest }, async () => { calls++; return remote; });
  const manager = new UpdateManager(store, checker);
  try {
    await manager.automatic('timer'); expect(calls).toBe(0);
    manager.save({ ...defaultUpdateSettings, enabled: true, frequency });
    await manager.automatic('timer'); expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + interval - 1);
    await new UpdateManager(store, checker).automatic('open'); expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    await manager.automatic('timer'); expect(calls).toBe(2);
    manager.save({ ...manager.settings(), enabled: false });
    vi.setSystemTime(Date.now() + interval);
    await manager.automatic('timer'); expect(calls).toBe(2);
  } finally { manager.stop(); store.close(); vi.useRealTimers(); }
});
it('checks on each page open, never on a timer, and persists failures without retrying each tick', async () => {
  const store = database(); let calls = 0;
  const manager = new UpdateManager(store, new UpdateChecker(current, async () => { calls++; throw new Error('offline'); }));
  try {
    manager.save({ ...defaultUpdateSettings, enabled: true, frequency: 'on-open' });
    await manager.automatic('timer'); expect(calls).toBe(0);
    await manager.automatic('open'); await manager.automatic('open'); expect(calls).toBe(2);
    expect(manager.state()).toMatchObject({ result: null, error: expect.any(String) });
    manager.save({ ...manager.settings(), frequency: 'hourly' });
    await manager.automatic('timer'); expect(calls).toBe(2);
    manager.save({ ...manager.settings(), channel: 'ci' }); expect(manager.state().checkedAt).toBeNull();
  } finally { store.close(); }
});
