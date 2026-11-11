import { isIP } from 'node:net';

type Options = { port: number; publicUrl?: string; https?: boolean; dev?: boolean };

export function createAccessPolicy({ port, publicUrl, https = false, dev = false }: Options) {
  const published = publicUrl ? new URL(publicUrl) : undefined;
  const developmentOrigins = new Set(dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []);
  return {
    originForHost(host: string) {
      const address = parseHost(host, https);
      if (!address) return undefined;
      if (published?.host === address.host) return published.origin;
      const hostname = address.hostname.replace(/^\[|\]$/g, '');
      // IP literals work through LAN, VPN and Docker port mappings without trusting arbitrary DNS names.
      return hostname === 'localhost' || isIP(hostname) ? address.origin : undefined;
    },
    acceptsOrigin(expected: string, origin: string) {
      if (origin === expected) return true;
      const address = new URL(expected);
      return developmentOrigins.has(origin) && ['127.0.0.1', 'localhost'].includes(address.hostname) && address.port === String(port);
    },
  };
}

function parseHost(host: string, https: boolean) {
  try {
    const address = new URL(`${https ? 'https' : 'http'}://${host}`);
    if (address.username || address.password || address.pathname !== '/' || address.search || address.hash) return undefined;
    return address;
  } catch { return undefined; }
}
