import type { Account, Address, ComposeMode, DraftInput, Message, MessageBody } from '@mail/shared';
import { escapeHtml, hasMeaningfulHtml, sanitizeQuoteHtml } from './mail-render';

// Drafts are saved through draftSchema later, so what is built here has to fit its limits.
const MAX_QUOTED = 500_000;
const MAX_HEADER = 998;
const MAX_ADDRESSES = 32_000;

export function composeDraft(
  message: Message,
  body: MessageBody,
  cc: Address[],
  mode: ComposeMode,
  accounts: Account[],
  timeZone = 'UTC',
  inlineUploadUrls?: Map<string, string>,
): DraftInput {
  const self = new Set(accounts.map(account => account.email.toLowerCase()));
  const authors = message.replyTo.length ? message.replyTo : message.from;
  const targets = authors.every(address => self.has(address.address.toLowerCase())) ? message.to : authors;
  let to = mode === 'forward' ? [] : uniqueAddresses(targets, self);
  // A note sent to oneself has nobody else to answer.
  if (mode !== 'forward' && !to.length) to = uniqueAddresses(authors, new Set());
  const copies = mode === 'reply-all' ? uniqueAddresses([...message.to, ...cc], new Set([...self, ...to.map(value => value.toLowerCase())])) : [];
  const prefix = mode === 'forward' ? 'Fwd:' : 'Re:';
  const original = message.subject.replace(/[\r\n]+/g, ' ');
  const subject = ((mode === 'forward' ? /^(fwd?|转发):/i : /^(re|回复):/i).test(original) ? original : `${prefix} ${original}`).slice(0, MAX_HEADER);
  const text = body.text.length > MAX_QUOTED ? `${body.text.slice(0, MAX_QUOTED)}\n…（原文过长，引用已截断）` : body.text;
  const heading = `发件人：${message.from.map(address => address.name ? `${address.name} <${address.address}>` : address.address).join(', ')}\n日期：${new Date(message.date).toLocaleString('zh-CN', { timeZone, timeZoneName: 'short' })}\n主题：${message.subject}\n收件人：${message.to.map(address => address.address).join(', ')}`;
  const quoted = `${heading}\n\n${text}`;

  // Preserve safe rich formatting (tables, lists, links, mapped inline images) when original HTML is meaningful.
  const sanitizedOriginalHtml = body.html ? sanitizeQuoteHtml(body.html.slice(0, MAX_QUOTED), inlineUploadUrls) : '';
  const richOriginal = hasMeaningfulHtml(sanitizedOriginalHtml) ? sanitizedOriginalHtml : '';
  const headingHtml = escapeHtml(heading).replace(/\n/g, '<br>');
  const fallbackBodyHtml = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  const bodyHtml = richOriginal || fallbackBodyHtml;

  const html = mode === 'forward'
    ? `<p></p><hr><p><strong>---------- 转发的邮件 ----------</strong><br>${headingHtml}</p>${bodyHtml}`
    : `<p></p><blockquote><p>${headingHtml}</p>${bodyHtml}</blockquote>`;

  const plainText = mode === 'forward'
    ? `\n\n---------- 转发的邮件 ----------\n${quoted}`
    : `\n\n${quoted.split('\n').map(line => `> ${line}`).join('\n')}`;

  return { accountId: message.accountId, to: joinWithin(to), cc: joinWithin(copies), bcc: '', subject,
    text: plainText,
    html,
    inReplyTo: mode === 'forward' || message.messageId.length > MAX_HEADER ? undefined : message.messageId || undefined,
    references: mode === 'forward' ? [] : [...message.references, message.messageId].filter(reference => reference && reference.length <= MAX_HEADER).slice(-100), attachmentIds: [] };
}

function uniqueAddresses(addresses: Address[], excluded: Set<string>) {
  const result: string[] = [];
  const seen = new Set(excluded);
  for (const { address } of addresses) if (address && !seen.has(address.toLowerCase())) { result.push(address); seen.add(address.toLowerCase()); }
  return result;
}
function joinWithin(addresses: string[]) {
  let line = '';
  for (const address of addresses) {
    const next = line ? `${line}, ${address}` : address;
    if (next.length > MAX_ADDRESSES) break;
    line = next;
  }
  return line;
}
