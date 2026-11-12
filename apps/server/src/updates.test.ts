import { expect, it } from 'vitest';
import type { BuildInfo } from '@mail/shared';
import { UpdateChecker } from './updates';

const old = 'a'.repeat(40); const latest = 'b'.repeat(40);
const current: BuildInfo = { version: '0.1.0', revision: old, builtAt: '2026-11-12T00:00:00.000Z', localChanges: false };
const remote = { sha: latest, commit: { message: '新增功能\n\n完整说明', committer: { date: '2026-11-12T01:00:00Z' } } };

it.each([['ahead', 'available'], ['behind', 'local-ahead'], ['identical', 'current'], ['diverged', 'diverged']] as const)('reports %s without confusing newer local builds with updates', async (status, expected) => {
  const calls: string[] = [];
  const check = new UpdateChecker(current, async url => { calls.push(url); return calls.length === 1 ? remote : { status }; });
  const result = await check.check();
  expect(result.status).toBe(expected); expect(result.latest.title).toBe('新增功能');
  expect(calls[1]).toContain(`${old}...${latest}`); expect(result.latest.url).toBe(`https://github.com/sisi0318/mailisle/commit/${latest}`);
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
