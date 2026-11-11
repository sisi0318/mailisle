import { expect, it } from 'vitest';
import { readConfig } from './config';

const password = 'test-config-password';
it('listens on every IPv4 interface by default and supports an explicit IPv6 or loopback bind', () => {
  expect(readConfig({ MAIL_MASTER_PASSWORD: password }, []).host).toBe('0.0.0.0');
  for (const host of ['::', '127.0.0.1', 'localhost']) expect(readConfig({ MAIL_MASTER_PASSWORD: password, MAIL_HOST: host }, []).host).toBe(host);
});
it.each([undefined, '', 'short', ' '.repeat(12), 'replace-with-a-long-secret', 'x'.repeat(1025)])('refuses an unusable or example startup password', value => {
  expect(() => readConfig({ MAIL_MASTER_PASSWORD: value }, [])).toThrow('MAIL_MASTER_PASSWORD');
});
it('validates network configuration once and keeps TLS optional', () => {
  expect(readConfig({ MAIL_MASTER_PASSWORD: password }, []).tls).toBeUndefined();
  expect(readConfig({ MAIL_MASTER_PASSWORD: password, MAIL_PUBLIC_URL: 'https://mail.example.com/', MAIL_TLS_CERT: 'certs/cert.pem', MAIL_TLS_KEY: 'certs/key.pem' }, []))
    .toMatchObject({ publicUrl: 'https://mail.example.com', tls: { cert: expect.stringContaining('cert.pem'), key: expect.stringContaining('key.pem') } });
  for (const fields of [{ MAIL_PORT: '0' }, { MAIL_PORT: '65536' }, { MAIL_HOST: 'bad host' }, { MAIL_TLS_CERT: 'cert.pem' },
    { MAIL_PUBLIC_URL: 'ftp://mail.example.com' }, { MAIL_PUBLIC_URL: 'https://user:secret@mail.example.com' }, { MAIL_PUBLIC_URL: 'https://mail.example.com/subpath' }])
    expect(() => readConfig({ MAIL_MASTER_PASSWORD: password, ...fields }, [])).toThrow();
});
it('keeps an existing example-password instance accessible only on loopback for migration', () => {
  expect(readConfig({ MAIL_MASTER_PASSWORD: 'replace-with-a-long-secret', MAIL_HOST: '127.0.0.1' }, []).host).toBe('127.0.0.1');
  expect(() => readConfig({ MAIL_MASTER_PASSWORD: 'replace-with-a-long-secret', MAIL_HOST: '192.168.1.20' }, [])).toThrow('示例密码');
});
