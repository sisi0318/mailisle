import { expect, it } from 'vitest';
import { publicError } from './service';

it('does not blame credentials for the reproduced local metadata exception', () => {
  const message = publicError(new TypeError("Cannot read properties of undefined (reading 'toString')"));
  expect(message).toContain('客户端');
  expect(message).toContain('TypeError');
  expect(message).not.toContain('密码');
});

it('only suggests checking authorization credentials for explicit authentication errors', () => {
  const authError = Object.assign(new Error('server response containing private details'), { authenticationFailed: true });
  expect(publicError(authError)).toContain('授权码');
  expect(publicError(authError)).not.toContain('private details');
  expect(publicError(Object.assign(new Error('SMTP authentication failure'), { code: 'EAUTH' }))).toContain('授权码');
  expect(publicError(new Error('Command failed'))).not.toContain('密码');
});
