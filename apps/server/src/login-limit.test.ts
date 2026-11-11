import { expect, it } from 'vitest';
import { clientKey, LoginLimiter } from './login-limit';

it('limits each client separately and forgets a client after its window', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 10; i++) expect(limiter.allow('203.0.113.7', 1_000)).toBe(true);
  expect(limiter.allow('203.0.113.7', 1_000)).toBe(false);
  expect(limiter.allow('192.168.1.20', 1_000)).toBe(true);
  expect(limiter.allow('203.0.113.7', 62_000)).toBe(true);
  limiter.reset('192.168.1.20');
  for (let i = 0; i < 10; i++) expect(limiter.allow('192.168.1.20', 62_000)).toBe(true);
});

it('keeps its memory bounded under a flood of addresses', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 12_000; i++) limiter.allow(`client-${i}`, 1_000);
  expect((limiter as unknown as { clients: Map<string, unknown> }).clients.size).toBeLessThanOrEqual(10_000);
});

it('counts an IPv6 /64 as one client and unwraps mapped IPv4 addresses', () => {
  expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
  expect(clientKey('::1')).toBe('0:0:0:0::/64');
  expect(clientKey('::ffff:192.168.1.20')).toBe('192.168.1.20');
  expect(clientKey('192.168.1.20')).toBe('192.168.1.20');
  expect(clientKey(undefined)).toBe('unknown');
});
