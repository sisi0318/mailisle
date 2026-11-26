import { expect, it } from 'vitest';
import type { Account, Message, MessageBody } from '@mail/shared';
import { composeDraft } from './compose';
import { record } from '../../../tests/fixtures';

const accounts: Account[] = [{ id: 'a', name: 'Me', email: 'me@example.com', lastSync: null, error: null }, { id: 'b', name: 'Other', email: 'other@example.com', lastSync: null, error: null }].map(account => ({ ...account, receiveEnabled: true, sendEnabled: true }));
const message: Message = { ...record(), id: 'm', accountId: 'a', threadId: 't', cached: true, seen: true, starred: false, preview: '',
  subject: '讨论', from: [{ name: 'Sender', address: 'sender@example.com' }], replyTo: [{ name: '', address: 'reply@example.com' }],
  to: [{ name: '', address: 'me@example.com' }, { name: '', address: 'team@example.com' }] };
const body: MessageBody = { text: '<script>not executable</script>\n正文', html: '<img src="https://tracker.invalid/">', attachments: [] };

it('uses Reply-To and quotes escaped text, not the original active HTML', () => {
  const draft = composeDraft(message, body, [], 'reply', accounts);
  expect(draft.to).toBe('reply@example.com'); expect(draft.cc).toBe('');
  expect(draft.inReplyTo).toBe(message.messageId);
  expect(draft.html).toContain('&lt;script&gt;'); expect(draft.html).not.toContain('<script>');
  expect(draft.html).not.toContain('tracker.invalid'); expect(draft.html).toContain('<blockquote>');
});
it('reply-all excludes own mailboxes and deduplicates recipients across To and Cc', () => {
  const draft = composeDraft(message, body, [{ name: '', address: 'TEAM@example.com' }, { name: '', address: 'other@example.com' }, { name: '', address: 'cc@example.com' }, { name: '', address: 'reply@example.com' }], 'reply-all', accounts);
  expect(draft.to).toBe('reply@example.com'); expect(draft.cc).toBe('team@example.com, cc@example.com'); expect(draft.bcc).toBe('');
});
it('replies to original recipients when reading a message sent by oneself', () => {
  const draft = composeDraft({ ...message, from: [{ name: '', address: 'me@example.com' }], replyTo: [] }, body, [], 'reply', accounts);
  expect(draft.to).toBe('team@example.com');
});
it('starts forwarding as a new conversation without copying recipient addresses', () => {
  const draft = composeDraft(message, body, [], 'forward', accounts);
  expect(draft.to).toBe(''); expect(draft.cc).toBe(''); expect(draft.subject).toBe('Fwd: 讨论');
  expect(draft.references).toEqual([]); expect(draft.inReplyTo).toBeUndefined();
});
it('formats quote dates in the requesting browser timezone', () => {
  const draft = composeDraft(message, body, [], 'reply', accounts, 'Asia/Shanghai');
  expect(draft.text).toContain('GMT+8'); expect(draft.text).toContain('8:00:00');
});
it('preserves safe rich HTML formatting and mapped inline images when forwarding', () => {
  const richBody: MessageBody = {
    text: '项目汇总',
    html: '<p><strong>项目汇总</strong></p><table><tr><th>模块</th><th>状态</th></tr><tr><td>写信</td><td>完成</td></tr></table><img src="cid:chart" alt="图表"><img src="https://tracker.invalid/px.png">',
    attachments: [],
  };
  const inlineUrls = new Map([['chart', '/api/uploads/11111111-1111-4111-8111-111111111111?inline=1']]);
  const draft = composeDraft(message, richBody, [], 'forward', accounts, 'UTC', inlineUrls);
  expect(draft.html).toContain('转发的邮件');
  expect(draft.html).toContain('<table>');
  expect(draft.html).toContain('/api/uploads/11111111-1111-4111-8111-111111111111?inline=1');
  expect(draft.html).not.toContain('tracker.invalid');
  expect(draft.html).not.toContain('<blockquote>');
});
