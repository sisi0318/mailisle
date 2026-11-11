import { expect, it, vi } from 'vitest';
import { discoverAccount, parseAutoConfig } from './autoconfig';

const xml = `<clientConfig version="1.1"><emailProvider id="example.com"><displayName>示例邮箱</displayName>
  <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username><authentication>OAuth2</authentication><authentication>password-cleartext</authentication></outgoingServer>
</emailProvider></clientConfig>`;

it('selects encrypted IMAP/SMTP and expands username templates', () => {
  expect(parseAutoConfig(xml, 'alice@example.com')).toEqual({ name: '示例邮箱', source: 'ispdb', requiresOAuth: false, sentCopy: 'append',
    imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'alice' }, smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'alice@example.com' } });
});
it('keeps Gmail server-side Sent saving for discovered configurations', () => {
  expect(parseAutoConfig(xml.replace('smtp.example.com', 'smtp.gmail.com'), 'alice@gmail.com')?.sentCopy).toBe('server');
});
it('reports OAuth-only settings and does not select plaintext-only settings', () => {
  expect(parseAutoConfig(xml.replaceAll('password-cleartext', 'OAuth2'), 'alice@example.com')?.requiresOAuth).toBe(true);
  expect(parseAutoConfig(xml.replaceAll('SSL', 'plain'), 'alice@example.com')).toBeNull();
});
it('rejects malformed configuration and invalid server ports', () => {
  expect(() => parseAutoConfig('<not-config/>', 'alice@example.com')).toThrow('配置');
  expect(() => parseAutoConfig(xml.replace('993', '99999'), 'alice@example.com')).toThrow('配置');
});
it('queries only the domain and treats an unknown provider as a manual-configuration fallback', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(xml)).mockResolvedValueOnce(new Response('', { status: 404 }));
  expect(await discoverAccount('private-user@example.com', request)).not.toBeNull();
  expect(request.mock.calls[0][0]).toBe('https://autoconfig.thunderbird.net/v1.1/example.com');
  expect(request.mock.calls[0][1]?.redirect).toBe('error');
  expect(await discoverAccount('private-user@example.com', request)).toBeNull();
});
