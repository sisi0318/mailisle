import { isIPv6 } from 'node:net';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_CLIENTS = 10_000;

/** Counts login attempts per client, so that one client guessing passwords cannot lock the owner out. */
export class LoginLimiter {
  private clients = new Map<string, { count: number; started: number }>();

  /** Records an attempt and says whether it may proceed. */
  allow(client: string, now = Date.now()) {
    let entry = this.clients.get(client);
    if (!entry || now - entry.started > WINDOW_MS) {
      if (!entry && this.clients.size >= MAX_CLIENTS) this.evict(now);
      entry = { count: 0, started: now };
      this.clients.delete(client);
      this.clients.set(client, entry);
    }
    return ++entry.count <= MAX_ATTEMPTS;
  }
  reset(client: string) { this.clients.delete(client); }

  private evict(now: number) {
    for (const [client, entry] of this.clients) if (now - entry.started > WINDOW_MS) this.clients.delete(client);
    // Every remaining entry is still inside its window; memory stays bounded by dropping the oldest.
    for (const client of this.clients.keys()) {
      if (this.clients.size < MAX_CLIENTS) break;
      this.clients.delete(client);
    }
  }
}

/** The counter a client address belongs to. An IPv6 client controls a whole /64, so those share one. */
export function clientKey(address: string | undefined) {
  if (!address) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return mapped;
  if (!isIPv6(address)) return address;
  const [head, tail] = address.split('%')[0].split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = tail === undefined ? leading : [...leading, ...Array<string>(Math.max(0, 8 - leading.length - trailing.length)).fill('0'), ...trailing];
  return `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(':')}::/64`;
}
