import type { MailStore } from '@mail/db';
import type { GlobalProxySettings, ProxyMode } from '@mail/shared';
import type { Vault } from './crypto';
import { UserError } from './errors';

type Preferences = { proxyMode?: ProxyMode; proxy?: string };
export class ProxySettings {
  constructor(private store: MailStore, private vault: Vault) {}
  globalUrl(): string | undefined {
    const encrypted = this.store.getSetting('global-proxy');
    return encrypted ? this.vault.decrypt<string | null>(encrypted) || undefined : undefined;
  }
  settings(): GlobalProxySettings {
    const value = this.globalUrl();
    return { configured: !!value, display: proxyDisplay(value) };
  }
  save(value: string | null) { this.store.setSetting('global-proxy', this.vault.encrypt(value)); }
  mode(config: Preferences): ProxyMode { return config.proxyMode ?? (config.proxy ? 'custom' : 'global'); }
  prepare(input: Preferences, previous?: Preferences): Preferences {
    const proxyMode = input.proxyMode ?? (input.proxy === '' ? 'direct' : input.proxy ? 'custom' : previous ? this.mode(previous) : 'global');
    const proxy = input.proxy === undefined ? previous?.proxy : input.proxy || undefined;
    if (proxyMode === 'custom' && !proxy) throw new UserError('请填写独立代理地址');
    return { proxyMode, proxy: proxyMode === 'custom' ? proxy : undefined };
  }
  resolve(config: Preferences) {
    const mode = this.mode(config);
    return mode === 'global' ? this.globalUrl() : mode === 'custom' ? config.proxy : undefined;
  }
}

export function proxyDisplay(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}
