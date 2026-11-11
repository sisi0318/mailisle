import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { providerPresets, type AutoConfig } from '@mail/shared';

const xmlServer = z.object({ '@_type': z.string(), hostname: z.string().min(1).max(253), port: z.coerce.number().int().min(1).max(65535),
  socketType: z.string(), username: z.string().min(1).max(320), authentication: z.array(z.string()).default([]) });
const xmlConfig = z.object({ clientConfig: z.object({ emailProvider: z.object({ displayName: z.string().optional(),
  incomingServer: z.array(xmlServer), outgoingServer: z.array(xmlServer) }) }) });

export async function discoverAccount(email: string, request: typeof fetch = fetch): Promise<AutoConfig | null> {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  let response: Response;
  try { response = await request(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
  catch { throw new Error('自动配置查询失败或超时，请使用预设或手动填写服务器'); }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('自动配置服务暂时不可用，请手动填写服务器');
  return parseAutoConfig(await response.text(), email);
}

export function parseAutoConfig(xml: string, email: string): AutoConfig | null {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false,
    isArray: name => ['incomingServer', 'outgoingServer', 'authentication'].includes(name) });
  let data: unknown;
  try { data = parser.parse(xml); } catch { throw new Error('自动配置内容无法解析，请手动填写'); }
  const parsed = xmlConfig.safeParse(data);
  if (!parsed.success) throw new Error('自动配置内容不完整，请手动填写');
  const provider = parsed.data.clientConfig.emailProvider;
  const imap = provider.incomingServer.find(server => server['@_type'] === 'imap' && ['SSL', 'STARTTLS'].includes(server.socketType));
  const smtp = provider.outgoingServer.find(server => server['@_type'] === 'smtp' && ['SSL', 'STARTTLS'].includes(server.socketType));
  if (!imap || !smtp) return null;
  const [local, domain] = email.split('@');
  const expand = (value: string) => value.replaceAll('%EMAILADDRESS%', email).replaceAll('%EMAILLOCALPART%', local).replaceAll('%EMAILDOMAIN%', domain);
  const server = (value: z.infer<typeof xmlServer>) => ({ host: expand(value.hostname), port: value.port,
    security: value.socketType === 'SSL' ? 'tls' as const : 'starttls' as const, user: expand(value.username) });
  const incoming = server(imap); const outgoing = server(smtp);
  const known = providerPresets.find(preset => preset.imap.host === incoming.host && preset.smtp.host === outgoing.host);
  return { name: provider.displayName ?? domain, source: 'ispdb', imap: incoming, smtp: outgoing, sentCopy: known?.sentCopy ?? 'append',
    requiresOAuth: [imap, smtp].some(server => server.authentication.includes('OAuth2') && !server.authentication.includes('password-cleartext')) };
}
