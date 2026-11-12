import { afterEach, beforeEach, expect, it } from 'vitest';
import { database } from '../../../tests/fixtures';
import { Vault } from './crypto';
import { ProxySettings } from './proxy';

let store: ReturnType<typeof database>;
let proxy: ProxySettings;
beforeEach(() => { store = database(); proxy = new ProxySettings(store, new Vault(Buffer.alloc(32))); });
afterEach(() => store.close());

it('inherits global defaults while preserving legacy independent proxies and explicit direct connections', () => {
  proxy.save('http://global:password@127.0.0.1:7890');
  expect(proxy.resolve({})).toBe('http://global:password@127.0.0.1:7890');
  expect(proxy.resolve({ proxy: 'socks5://127.0.0.1:1080' })).toBe('socks5://127.0.0.1:1080');
  expect(proxy.resolve({ proxyMode: 'direct' })).toBeUndefined();
  expect(proxy.prepare({}, { proxy: 'socks5://127.0.0.1:1080' })).toEqual({ proxyMode: 'custom', proxy: 'socks5://127.0.0.1:1080' });
  expect(proxy.prepare({ proxyMode: 'global' }, { proxy: 'socks5://127.0.0.1:1080' })).toEqual({ proxyMode: 'global', proxy: undefined });
  expect(proxy.prepare({ proxy: '' }, { proxy: 'socks5://127.0.0.1:1080' })).toEqual({ proxyMode: 'direct', proxy: undefined });
  expect(() => proxy.prepare({ proxyMode: 'custom' })).toThrow('独立代理');
});

it('encrypts stored proxy credentials and only returns a redacted display value', () => {
  proxy.save('socks5://test-user:test-secret@127.0.0.1:1080');
  expect(store.getSetting('global-proxy')).not.toContain('test-secret');
  expect(proxy.settings()).toEqual({ configured: true, display: 'socks5://127.0.0.1:1080' });
  proxy.save(null); expect(proxy.settings()).toEqual({ configured: false, display: undefined });
});
