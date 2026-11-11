import { isIP } from 'node:net';
import { resolve } from 'node:path';

export const EXAMPLE_PASSWORD = 'replace-with-a-long-secret';
const loopback = ['localhost', '127.0.0.1', '::1'];

export function readConfig(env: NodeJS.ProcessEnv = process.env, args = process.argv) {
  const host = env.MAIL_HOST?.trim() || '0.0.0.0';
  if (host !== 'localhost' && !isIP(host)) throw new Error('MAIL_HOST 必须是监听 IP 或 localhost，例如 0.0.0.0、::、127.0.0.1');
  const publicUrl = readPublicUrl(env.MAIL_PUBLIC_URL);
  // Listening on loopback behind a reverse proxy is still reachable from outside, so the published address counts as well.
  const localOnly = loopback.includes(host) && (!publicUrl || loopback.includes(new URL(publicUrl).hostname.replace(/^\[|\]$/g, '')));
  const password = validateMasterPassword(env.MAIL_MASTER_PASSWORD, localOnly);
  const port = Number(env.MAIL_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MAIL_PORT 必须为 1–65535 的整数');
  const cert = env.MAIL_TLS_CERT?.trim(); const key = env.MAIL_TLS_KEY?.trim();
  if (!!cert !== !!key) throw new Error('MAIL_TLS_CERT 和 MAIL_TLS_KEY 必须同时设置');
  // An empty MAIL_DATA_DIR= would otherwise resolve to the working directory itself.
  return { password, host, port, publicUrl, tls: cert && key ? { cert: resolve(cert), key: resolve(key) } : undefined,
    dataDir: resolve(env.MAIL_DATA_DIR?.trim() || '.data'), dev: args.includes('--dev') };
}

export function validateMasterPassword(password?: string, allowLocalExample = false) {
  if (!password || password.trim().length < 12 || password.length > 1024 || (!allowLocalExample && password === EXAMPLE_PASSWORD))
    throw new Error('请设置自己的 MAIL_MASTER_PASSWORD：12–1024 个字符；示例密码仅允许本机访问，不能用于远程监听');
  return password;
}

function readPublicUrl(value?: string) {
  if (!value?.trim()) return undefined;
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('MAIL_PUBLIC_URL 必须是完整的 HTTP 或 HTTPS 访问地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('MAIL_PUBLIC_URL 只填写访问源，例如 https://mail.example.com，不含账号、子路径或查询参数');
  return url.origin;
}
