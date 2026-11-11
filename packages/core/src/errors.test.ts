import { expect, it } from 'vitest';
import { errorStatus, publicError, UserError } from './errors';

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

it('shows messages written for the user even when they start with a product name', () => {
  expect(publicError(new Error('Google 桌面客户端需要 Client secret'))).toBe('Google 桌面客户端需要 Client secret');
  expect(publicError(new UserError('Draft is gone', 404))).toBe('Draft is gone');
  expect(errorStatus(new UserError('草稿不存在', 404))).toBe(404);
  expect(publicError(new Error('NO [AUTHENTICATIONFAILED] user alice@example.com secret'))).toBe('邮件操作未完成，请稍后重试');
});

it('does not blame the mail server for local storage failures', () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open 'body.json'"), { code: 'ENOENT', path: 'body.json' });
  expect(publicError(missing)).toContain('本机数据读写失败');
  expect(errorStatus(missing)).toBe(500);
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:993'), { code: 'ECONNREFUSED' });
  expect(publicError(refused)).toContain('邮件服务器连接失败');
  expect(errorStatus(refused)).toBe(502);
  expect(errorStatus(new SyntaxError('Unexpected token'))).toBe(500);
});
