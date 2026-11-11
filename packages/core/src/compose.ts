import type { Account, Address, ComposeMode, DraftInput, Message, MessageBody } from '@mail/shared';

export function composeDraft(message: Message, body: MessageBody, cc: Address[], mode: ComposeMode, accounts: Account[], timeZone = 'UTC'): DraftInput {
  const self = new Set(accounts.map(account => account.email.toLowerCase()));
  const authors = message.replyTo.length ? message.replyTo : message.from;
  const targets = authors.every(address => self.has(address.address.toLowerCase())) ? message.to : authors;
  const to = mode === 'forward' ? [] : uniqueAddresses(targets, self);
  const copies = mode === 'reply-all' ? uniqueAddresses([...message.to, ...cc], new Set([...self, ...to.map(value => value.toLowerCase())])) : [];
  const prefix = mode === 'forward' ? 'Fwd:' : 'Re:';
  const subject = (mode === 'forward' ? /^(fwd?|转发):/i : /^(re|回复):/i).test(message.subject) ? message.subject : `${prefix} ${message.subject}`;
  const heading = `发件人：${message.from.map(address => address.name ? `${address.name} <${address.address}>` : address.address).join(', ')}\n日期：${new Date(message.date).toLocaleString('zh-CN', { timeZone, timeZoneName: 'short' })}\n主题：${message.subject}\n收件人：${message.to.map(address => address.address).join(', ')}`;
  const quoted = `${heading}\n\n${body.text}`;
  return { accountId: message.accountId, to: to.join(', '), cc: copies.join(', '), bcc: '', subject,
    text: `\n\n${quoted.split('\n').map(line => `> ${line}`).join('\n')}`,
    html: `<p></p><blockquote><p>${escapeHtml(quoted).replace(/\n/g, '<br>')}</p></blockquote>`,
    inReplyTo: mode === 'forward' ? undefined : message.messageId || undefined,
    references: mode === 'forward' ? [] : [...message.references, message.messageId].filter(Boolean).slice(-100), attachmentIds: [] };
}

function uniqueAddresses(addresses: Address[], excluded: Set<string>) {
  const result: string[] = [];
  const seen = new Set(excluded);
  for (const { address } of addresses) if (address && !seen.has(address.toLowerCase())) { result.push(address); seen.add(address.toLowerCase()); }
  return result;
}
function escapeHtml(text: string) { return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
