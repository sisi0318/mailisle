import { expect, it } from 'vitest';
import { accountSchema, accountUpdateSchema, oauthStartSchema } from './index';

const server = { host: 'mail.example.com', port: 993, security: 'tls', user: 'user@example.com', password: 'test-password' };
const identity = { name: 'Test', email: 'user@example.com' };

it('requires configuration only for enabled mail channels and defaults existing clients to both', () => {
  expect(accountSchema.parse({ ...identity, receiveEnabled: true, sendEnabled: false, imap: server })).toMatchObject({ smtp: { host: '' }, sendEnabled: false });
  expect(accountSchema.parse({ ...identity, receiveEnabled: false, sendEnabled: true, smtp: server })).toMatchObject({ imap: { host: '' }, receiveEnabled: false });
  expect(accountSchema.parse({ ...identity, imap: server, smtp: server })).toMatchObject({ receiveEnabled: true, sendEnabled: true });
  expect(accountSchema.safeParse({ ...identity, receiveEnabled: false, sendEnabled: false }).success).toBe(false);
  expect(accountSchema.safeParse({ ...identity, receiveEnabled: true, sendEnabled: false, imap: { ...server, password: '' } }).success).toBe(false);
  expect(accountUpdateSchema.parse({ ...identity, receiveEnabled: false, sendEnabled: true, smtp: { ...server, password: undefined } }).smtp.password).toBeUndefined();
});

it('allows OAuth for one enabled protocol without requiring the other endpoint', () => {
  expect(oauthStartSchema.safeParse({ provider: 'google', client: { source: 'preset' }, account: {
    ...identity, receiveEnabled: true, sendEnabled: false, imap: { ...server, host: 'imap.gmail.com' },
  } }).success).toBe(true);
  expect(oauthStartSchema.safeParse({ provider: 'microsoft', client: { source: 'preset' }, account: {
    ...identity, receiveEnabled: false, sendEnabled: true, smtp: { ...server, host: 'smtp.office365.com', port: 587, security: 'starttls' },
  } }).success).toBe(true);
});
